import { type ExtensionState, type StoredTest } from '../types';
import { StorageService } from '../storage/StorageService';
import type { ProxyProfile } from '../types';
import { buildPacScript } from '../utils/siteRules';
import {
  APP_NAME,
  computeNextState,
  expectsOwnership,
  isRoutingActive,
  opNeedsRouting,
  shouldUsePac,
  validateAcceptCurrentIp,
  validateAcceptTest,
  type MutationOp,
} from './RoutingOps';

function hasProxyApi(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.proxy?.settings;
}

function hasMessaging(): boolean {
  return (
    typeof chrome !== 'undefined' && !!(chrome.runtime as unknown as { sendMessage?: unknown })?.sendMessage
  );
}

function newOpId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `op_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

export type ControlState =
  | 'ours' // extension currently controls the proxy
  | 'controllable' // default/system; extension may take control
  | 'other-extension' // another extension controls proxy settings
  | 'policy' // browser policy (or other non-controllable) owns settings
  | 'unavailable'; // no chrome.proxy API (dev mode)

export type BackgroundOpRequest = { type: 'onlyproxy:mutate'; op: MutationOp; opId: string };
export type BackgroundOpResponse =
  | { ok: true; opId?: string }
  | {
      ok: false;
      error: string;
      kind?: ProxyControlError['kind'];
      code?: 'storage' | 'stale-route' | 'not-owned';
      opId?: string;
    };

/** The background owner could not be reached. Completion is uncertain. */
export class BackgroundUnreachableError extends Error {
  constructor() {
    super(
      'OnlyProxy background did not respond. The change may or may not have applied — state was refreshed, please check before retrying.',
    );
    this.name = 'BackgroundUnreachableError';
  }
}

/** A connection-test result was discarded: the route moved or ownership lapsed. */
export class RouteStaleError extends Error {
  code: 'stale-route' | 'not-owned';
  constructor(code: 'stale-route' | 'not-owned') {
    super(
      code === 'not-owned'
        ? 'Proxy control was lost during the test — result discarded.'
        : 'Settings changed during the test — result discarded.',
    );
    this.name = 'RouteStaleError';
    this.code = code;
  }
}

/**
 * Exactly-once delivery attempt to the background owner. Returns null on
 * transport failure (thrown send, closed port, missing/invalid response) —
 * which proves NOTHING about whether the operation executed, so callers must
 * never replay the mutation locally. opIds are deduplicated by the background
 * (in-memory within its lifetime, persisted across restarts); this layer
 * deliberately performs NO automatic retry, because a retry after a worker
 * restart could otherwise execute a committed operation twice. Uncertainty is
 * reported to the caller instead.
 */
async function sendOnce(op: MutationOp, opId: string): Promise<BackgroundOpResponse | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'onlyproxy:mutate',
      op,
      opId,
    } as BackgroundOpRequest)) as BackgroundOpResponse | undefined;
    if (res && typeof res === 'object' && 'ok' in res) return res;
    return null;
  } catch {
    return null;
  }
}

function toControlError(res: BackgroundOpResponse & { ok: false }): Error {
  if (res.kind === 'other-extension' || res.kind === 'policy' || res.kind === 'rejected') {
    return new ProxyControlError(res.kind);
  }
  return new Error(res.error || 'Failed to apply proxy settings.');
}

// Serializes the dev-mode fallback read/compute/write/apply sequence as one
// unit (the production equivalent is the background op queue).
let localOpChain: Promise<void> = Promise.resolve();

function runLocalExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = localOpChain.catch(() => {}).then(fn);
  localOpChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Thin wrapper over chrome.proxy so React components never touch the
 * proxy API directly.
 *
 * Auth model: HTTP/HTTPS credentials are handed to the background service
 * worker (chrome.webRequest.onAuthRequired). SOCKS usernames/passwords are
 * stored but Chromium ignores them — see README "Limitations".
 *
 * All routing-affecting mutations go through a single background owner when
 * available (serializing popup <-> options races). The local path below is a
 * dev/test fallback with the same snapshot/rollback semantics.
 */
export const ProxyService = {
  buildConfig(profile: ProxyProfile): chrome.proxy.ProxyConfig {
    return {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: profile.protocol,
          host: profile.host,
          port: profile.port,
        },
        bypassList: ['localhost', '127.0.0.1', '<local>'],
      },
    };
  },

  async getControlState(): Promise<ControlState> {
    if (!hasProxyApi()) return 'unavailable';
    try {
      const detail = await chrome.proxy.settings.get({});
      switch (detail.levelOfControl) {
        case 'controlled_by_this_extension':
          return 'ours';
        case 'controllable_by_this_extension':
          return 'controllable';
        case 'controlled_by_other_extensions':
          return 'other-extension';
        case 'not_controllable':
        default:
          return 'policy';
      }
    } catch {
      return 'policy';
    }
  },

  /**
   * True when stored state disagrees with the browser: we should be routing
   * (active profile and/or site rules) but the extension no longer controls
   * the proxy (changed outside).
   */
  async detectExternalChange(): Promise<boolean> {
    if (!hasProxyApi()) return false;
    const [state, control] = await Promise.all([
      StorageService.getState(),
      ProxyService.getControlState(),
    ]);
    const shouldRoute =
      state.activeProfileId !== null ||
      (state.rulesEnabled && state.rules.some((r) => r.enabled));
    return shouldRoute && control !== 'ours';
  },

  /** PAC mode when the master switch is on and at least one rule is enabled. */
  usePac(state: ExtensionState): boolean {
    return shouldUsePac(state);
  },

  /** Badge is ON whenever we route traffic (global proxy and/or site rules). */
  isRoutingActive(state: ExtensionState): boolean {
    return isRoutingActive(state);
  },

  async updateBadge(active: boolean): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return;
      if (active) {
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    } catch {
      /* badge is best-effort */
    }
  },

  /**
   * Applies a concrete state to the browser: PAC script when site rules are
   * in effect, otherwise fixed_servers for the active profile, otherwise
   * clear() for the default/system connection. Throws ProxyControlError on
   * conflict/rejection or when a post-apply ownership check fails.
   */
  async applyRoutingFor(state: ExtensionState): Promise<void> {
    if (!hasProxyApi()) return;
    const control = await ProxyService.getControlState();
    if (control === 'other-extension' || control === 'policy') {
      throw new ProxyControlError(control);
    }
    const didSet = shouldUsePac(state) || !!state.activeProfileId;
    try {
      if (shouldUsePac(state)) {
        await chrome.proxy.settings.set({
          value: {
            mode: 'pac_script',
            pacScript: {
              mandatory: true,
              data: buildPacScript(state.rules, state.profiles, state.activeProfileId),
            },
          },
          scope: 'regular',
        });
      } else if (state.activeProfileId) {
        const profile = state.profiles.find((p) => p.id === state.activeProfileId);
        if (!profile) {
          // Active profile vanished — release control instead of guessing.
          await chrome.proxy.settings.clear({ scope: 'regular' });
        } else {
          await chrome.proxy.settings.set({
            value: ProxyService.buildConfig(profile),
            scope: 'regular',
          });
        }
      } else {
        // clear() removes extension-controlled rules and restores the
        // browser default/system connection (which may itself use a proxy).
        await chrome.proxy.settings.clear({ scope: 'regular' });
      }
    } catch {
      throw new ProxyControlError('rejected');
    }
    // Post-apply ownership check: a concurrent controller change must not be
    // reported as success.
    const after = await ProxyService.getControlState();
    if (after === 'other-extension' || after === 'policy') {
      throw new ProxyControlError(after);
    }
    if (didSet && after !== 'ours') {
      throw new ProxyControlError('rejected');
    }
    await ProxyService.updateBadge(isRoutingActive(state));
    // Wake the service worker so the auth handler is armed with fresh creds.
    try {
      if (hasMessaging()) await chrome.runtime.sendMessage({ type: 'proxy-applied' });
    } catch {
      /* service worker may be starting; it re-reads storage on wake */
    }
  },

  /**
   * Applies the stored state to the browser: PAC script when site rules are
   * in effect, otherwise fixed_servers for the active profile, otherwise
   * clear() for the default/system connection. Throws ProxyControlError on
   * conflict/rejection.
   */
  async applyRouting(): Promise<void> {
    const state = await StorageService.getFreshState().catch(() => StorageService.getState());
    await ProxyService.applyRoutingFor(state);
  },

/**
 * Single entry for every state mutation.
 *
 * Production path (extension APIs present): the background worker is the ONLY
 * writer. A transport failure proves nothing about execution — the mutation
 * may have committed with its response lost (including across a worker
 * restart, where in-memory dedup is gone). So the mutation is never replayed
 * locally and no automatic retry is issued: state is refreshed and a
 * BackgroundUnreachableError reports the uncertainty. Callers surface the
 * message so the user checks before retrying manually.
 *
 * Dev path (no chrome.runtime messaging, e.g. plain-web-page iteration): the
 * mutation runs locally, serialized as one unit with identical
 * snapshot/rollback semantics.
 */
  async dispatchOp(op: MutationOp): Promise<void> {
    if (hasMessaging()) {
      const opId = newOpId();
      const res = await sendOnce(op, opId);
      if (!res) {
        await StorageService.getFreshState().catch(() => {});
        throw new BackgroundUnreachableError();
      }
      if (res.ok) return;
      if (res.code === 'stale-route' || res.code === 'not-owned') {
        throw new RouteStaleError(res.code);
      }
      throw toControlError(res);
    }
    // Local dev fallback.
    return runLocalExclusive(async () => {
      const prev = await StorageService.getFreshState().catch(() => StorageService.getState());
      if (op.kind === 'acceptTest' || op.kind === 'acceptCurrentIp') {
        await ProxyService.acceptLocally(prev, op);
        return;
      }
      const next = computeNextState(prev, op);
      await StorageService.saveState(next);
      if (!opNeedsRouting(op)) return;
      if (!hasProxyApi()) return;
      try {
        await ProxyService.applyRoutingFor(next);
      } catch (e) {
        // Roll back to the previous snapshot so stored state never claims a
        // route the browser rejected. Best-effort re-apply keeps the browser
        // and storage consistent when the old route is still available.
        // The rollback carries a FRESH revision (never a rewind) and drops
        // cached results: the failed route may have been installed briefly,
        // so any test verified against the old revision is stale.
        const rollbackRev = Math.max(prev.routingRevision ?? 0, next.routingRevision ?? 0) + 1;
        await StorageService.saveState({
          ...prev,
          routingRevision: rollbackRev,
          tests: {},
          currentIp: null,
        }).catch(() => {});
        if (hasProxyApi()) {
          try {
            await ProxyService.applyRoutingFor(prev);
          } catch {
            /* original error below is what callers must see */
          }
        }
        throw e;
      }
    });
  },

  /**
   * Dev-fallback side of atomic test acceptance (mirrors the background
   * owner): revision + route must still match, and in extension-API mode the
   * proxy must still be ours (for profile tests) or owned-while-routing (for
   * current-connection checks). Rejections throw RouteStaleError and write
   * nothing, so a stale success can never be recorded.
   */
  async acceptLocally(
    prev: ExtensionState,
    op: Extract<MutationOp, { kind: 'acceptTest' | 'acceptCurrentIp' }>,
  ): Promise<void> {
    if (op.kind === 'acceptTest') {
      if (validateAcceptTest(prev, op.key, op.revision) !== 'ok') {
        throw new RouteStaleError('stale-route');
      }
      if (hasProxyApi() && (await ProxyService.getControlState()) !== 'ours') {
        throw new RouteStaleError('not-owned');
      }
    } else {
      if (validateAcceptCurrentIp(prev, op.revision) !== 'ok') {
        throw new RouteStaleError('stale-route');
      }
      if (hasProxyApi() && expectsOwnership(prev) && (await ProxyService.getControlState()) !== 'ours') {
        throw new RouteStaleError('not-owned');
      }
    }
    await StorageService.saveState(computeNextState(prev, op));
  },

  async applyProfile(profile: ProxyProfile): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'activate', id: profile.id });
  },

  async applyDirect(): Promise<void> {
    // A failed clear must NOT be recorded as Direct: dispatchOp rolls back
    // and surfaces the error to the caller.
    await ProxyService.dispatchOp({ kind: 'activate', id: null });
    try {
      if (hasMessaging()) await chrome.runtime.sendMessage({ type: 'proxy-cleared' });
    } catch {
      /* ignore */
    }
  },

  async upsertProfile(profile: ProxyProfile): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'upsert', profile });
  },

  async deleteProfile(id: string): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'delete', id });
  },

  async addProfiles(profiles: ProxyProfile[], favoriteIds: string[] = []): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'addMany', profiles, favoriteIds });
  },

  async replaceAll(profiles: ProxyProfile[], favoriteIds: string[] = []): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'replace', profiles, favoriteIds });
  },

  async updateRules(
    rules: ExtensionState['rules'],
    rulesEnabled: boolean,
  ): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'rules', rules, rulesEnabled });
  },

  async addRule(rule: ExtensionState['rules'][number]): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'ruleAdd', rule });
  },

  async deleteRule(id: string): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'ruleDelete', id });
  },

  async patchRule(
    id: string,
    patch: Partial<Pick<ExtensionState['rules'][number], 'pattern' | 'targetProfileId' | 'enabled'>>,
  ): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'rulePatch', id, patch });
  },

  async moveRule(id: string, dir: -1 | 1): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'ruleMove', id, dir });
  },

  async setRulesEnabled(enabled: boolean): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'rulesEnabled', enabled });
  },

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'favorite', id, favorite });
  },

  async patchSettings(patch: Partial<ExtensionState['settings']>): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'settings', patch });
  },

  /**
   * Atomically record a connection-test result verified against `revision`.
   * The background owner accepts it only when the revision still matches, the
   * tested route still resolves, and ownership still holds — otherwise it
   * throws RouteStaleError and records nothing.
   */
  async acceptTest(key: string, test: StoredTest, revision: number): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'acceptTest', key, test, revision });
  },

  async acceptCurrentIp(test: StoredTest, revision: number): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'acceptCurrentIp', test, revision });
  },

  /** True when the extension currently controls the proxy (vs default). */
  async isExtensionControlled(): Promise<boolean> {
    if (!hasProxyApi()) {
      const s = await StorageService.getSettings();
      return s.activeProfileId !== null;
    }
    return (await ProxyService.getControlState()) === 'ours';
  },
};

export class ProxyControlError extends Error {
  kind: 'other-extension' | 'policy' | 'rejected';
  constructor(kind: 'other-extension' | 'policy' | 'rejected') {
    super(kind);
    this.kind = kind;
  }
}

export function friendlyControlError(kind: ProxyControlError['kind']): string {
  if (kind === 'other-extension') {
    return `Proxy settings are currently controlled by another extension. Disable it to let ${APP_NAME} take control.`;
  }
  if (kind === 'policy') {
    return 'Proxy settings are controlled by browser policy and cannot be changed by this extension.';
  }
  return 'Browser rejected the proxy settings. Check host and port, then try again.';
}
