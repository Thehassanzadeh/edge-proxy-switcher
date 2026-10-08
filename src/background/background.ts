import { buildPacScript } from '../utils/siteRules';
import { migrateState } from '../storage/StorageService';
import {
  computeNextState,
  expectsOwnership,
  opNeedsRouting,
  resolveTargetForHost,
  selectAuthCandidate,
  validateAcceptCurrentIp,
  validateAcceptTest,
  type MutationOp,
} from '../services/RoutingOps';

/**
 * MV3 service worker.
 *
 * Jobs:
 *  1. Supply HTTP/HTTPS proxy credentials via webRequest.onAuthRequired.
 *  2. Re-arm that handler on startup (service workers are ephemeral).
 *  3. Re-apply the remembered active profile on browser startup so the
 *     session matches what the popup shows.
 *  4. Keep the action badge in sync (ON = proxy active, empty = default).
 *  5. Own all state mutations (single serialization point for popup/options).
 *  6. Open the onboarding page on first install.
 *
 * What it does NOT do: SOCKS4/SOCKS5 authentication. Chromium does not
 * implement SOCKS5 auth for extensions (crbug.com/1309413) and silently
 * ignores those credentials. See README "Limitations".
 *
 * No timers, no polling, no analytics. Everything is event-driven.
 */

interface StoredSettings {
  activeProfileId?: string | null;
}

interface StoredProfile {
  id: string;
  name: string;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

interface SiteRuleState {
  id: string;
  pattern: string;
  targetProfileId: string | null;
  enabled: boolean;
}

interface Store {
  state?: {
    settings?: StoredSettings;
    profiles?: StoredProfile[];
    activeProfileId?: string | null;
    rules?: SiteRuleState[];
    rulesEnabled?: boolean;
    favoriteIds?: string[];
    recentIds?: string[];
    tests?: Record<string, unknown>;
    currentIp?: unknown;
  };
  // legacy split keys (pre-v1) — still honored for auth until migration runs
  settings?: StoredSettings;
  profiles?: StoredProfile[];
}

interface Routing {
  activeId: string | null;
  profiles: StoredProfile[];
  rules: SiteRuleState[];
  rulesEnabled: boolean;
}

async function readRawStore(): Promise<Store> {
  return (await chrome.storage.local.get(null)) as Store;
}

async function readStore(): Promise<Routing> {
  const raw = await readRawStore();
  if (raw.state) {
    return {
      activeId: raw.state.activeProfileId ?? raw.state.settings?.activeProfileId ?? null,
      profiles: raw.state.profiles ?? [],
      rules: raw.state.rules ?? [],
      rulesEnabled: raw.state.rulesEnabled ?? false,
    };
  }
  return {
    activeId: raw.settings?.activeProfileId ?? null,
    profiles: raw.profiles ?? [],
    rules: [],
    rulesEnabled: false,
  };
}

// --- Replay protection that survives worker restarts ---
//
// In-memory dedup (`recentMutations`) dies with the worker, so applied
// operation IDs are ALSO persisted in storage — in the SAME `set` call as the
// resulting state (a single storage write is atomic), never in a separate
// non-atomic "remember op" write. A fresh worker therefore still recognizes a
// resent opId and returns the original result instead of executing twice.

const K_APPLIED_OPS = 'onlyproxy:appliedOps';
const MAX_APPLIED_OPS = 100;

function readAppliedOps(raw: Record<string, unknown>): Record<string, MutateResult> {
  const v = raw[K_APPLIED_OPS];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, MutateResult> = {};
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (r && typeof r === 'object' && typeof (r as { ok: unknown }).ok === 'boolean') {
      out[k] = r as MutateResult;
    }
  }
  return out;
}

function withAppliedOp(
  applied: Record<string, MutateResult>,
  opId: string,
  result: MutateResult,
): Record<string, MutateResult> {
  const { opId: _drop, ...rest } = result as MutateResult & { opId?: string };
  void _drop;
  const next = { ...applied, [opId]: rest as MutateResult };
  const keys = Object.keys(next);
  if (keys.length > MAX_APPLIED_OPS) {
    for (const k of keys.slice(0, keys.length - MAX_APPLIED_OPS)) delete next[k];
  }
  return next;
}

function hasApis(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.webRequest?.onAuthRequired &&
    !!chrome.storage?.local
  );
}

// --- Single serialization point for mutations (popup <-> options) ---

let opChain: Promise<void> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.catch(() => {}).then(fn);
  opChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

type MutateResult =
  | { ok: true; opId?: string }
  | {
      ok: false;
      error: string;
      kind?: 'other-extension' | 'policy' | 'rejected';
      code?: 'storage' | 'stale-route' | 'not-owned';
      opId?: string;
    };

// Exactly-once bookkeeping for UI retries: opId -> settled or in-flight
// result. Retries reuse the same opId, so a lost response never re-executes
// the mutation (no duplicated imports, no double rule moves).
const recentMutations = new Map<string, { at: number; result?: MutateResult; pending?: Promise<MutateResult> }>();
const MAX_RECENT_MUTATIONS = 100;
const MUTATION_TTL_MS = 5 * 60_000;

function rememberMutation(opId: string, entry: { at: number; result?: MutateResult; pending?: Promise<MutateResult> }): void {
  recentMutations.set(opId, entry);
  if (recentMutations.size > MAX_RECENT_MUTATIONS) {
    const oldest = [...recentMutations.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) recentMutations.delete(oldest);
  }
}

async function applyStateToBrowser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any,
): Promise<void> {
  if (!chrome.proxy?.settings) return;
  const current = await chrome.proxy.settings.get({});
  if (
    current.levelOfControl === 'controlled_by_other_extensions' ||
    current.levelOfControl === 'not_controllable'
  ) {
    throw {
      kind:
        current.levelOfControl === 'controlled_by_other_extensions'
          ? 'other-extension'
          : 'policy',
    };
  }
  const pacMode = state.rulesEnabled && state.rules.some((r: SiteRuleState) => r.enabled);
  const didSet = pacMode || !!state.activeProfileId;
  try {
    if (pacMode) {
      await chrome.proxy.settings.set({
        value: {
          mode: 'pac_script',
          pacScript: {
            data: buildPacScript(state.rules, state.profiles, state.activeProfileId),
            mandatory: true,
          },
        },
        scope: 'regular',
      });
    } else if (state.activeProfileId) {
      const active = (state.profiles as StoredProfile[]).find(
        (p) => p.id === state.activeProfileId,
      );
      if (!active) {
        await chrome.proxy.settings.clear({ scope: 'regular' });
      } else {
        await chrome.proxy.settings.set({
          value: {
            mode: 'fixed_servers',
            rules: {
              singleProxy: { scheme: active.protocol, host: active.host, port: active.port },
              bypassList: ['localhost', '127.0.0.1', '<local>'],
            },
          },
          scope: 'regular',
        });
      }
    } else {
      // Default/system connection (may itself use a proxy) — not "no proxy".
      await chrome.proxy.settings.clear({ scope: 'regular' });
    }
  } catch {
    throw { kind: 'rejected' };
  }
  const after = await chrome.proxy.settings.get({});
  if (
    after.levelOfControl === 'controlled_by_other_extensions' ||
    after.levelOfControl === 'not_controllable'
  ) {
    throw {
      kind:
        after.levelOfControl === 'controlled_by_other_extensions'
          ? 'other-extension'
          : 'policy',
    };
  }
  if (didSet && after.levelOfControl !== 'controlled_by_this_extension') {
    throw { kind: 'rejected' };
  }
}

async function handleMutate(op: MutationOp, opId?: string): Promise<MutateResult> {
  // Deduplicate UI retries (same opId): return the settled result, or join
  // the in-flight execution — never run the mutation twice. The persisted
  // record (see executeMutate) extends this across worker restarts.
  if (opId) {
    const known = recentMutations.get(opId);
    if (known?.result) return { ...known.result, opId };
    if (known?.pending) return known.pending.then((r) => ({ ...r, opId }));
  }
  const pending = runExclusive(async (): Promise<MutateResult> => {
    try {
      return await executeMutate(op, opId);
    } catch {
      // Storage failures (initial read, final write) must also produce a
      // structured response — never leave the caller hanging.
      return { ok: false, error: 'storage-failed', code: 'storage', opId };
    }
  });
  if (opId) {
    rememberMutation(opId, { at: Date.now(), pending });
    void pending.then(
      (result) => rememberMutation(opId, { at: Date.now(), result }),
      () => recentMutations.delete(opId),
    );
    setTimeout(() => {
      const known = recentMutations.get(opId);
      if (known && Date.now() - known.at > MUTATION_TTL_MS) recentMutations.delete(opId);
    }, MUTATION_TTL_MS);
  }
  const settled = await pending;
  return opId ? { ...settled, opId } : settled;
}

async function executeMutate(op: MutationOp, opId?: string): Promise<MutateResult> {
  // Single fresh read: persisted replay record + state travel together.
  const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const applied = readAppliedOps(raw);
  if (opId && applied[opId]) return { ...applied[opId], opId };
  const prev = migrateState(raw);

  const finish = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finalState: any,
    result: MutateResult,
  ): Promise<MutateResult> => {
    // The replay record commits atomically WITH the resulting state.
    if (opId) {
      await chrome.storage.local.set({
        state: finalState,
        [K_APPLIED_OPS]: withAppliedOp(applied, opId, result),
      });
    } else {
      await chrome.storage.local.set({ state: finalState });
    }
    await syncBadge();
    return opId ? { ...result, opId } : result;
  };

  // Atomic test acceptance: revision + route must still match, and (in
  // extension mode) ownership must still hold. Anything else is discarded
  // WITHOUT writing a success, so a stale result can never be recorded —
  // including a routing change that lands between the check and this write.
  if (op.kind === 'acceptTest' || op.kind === 'acceptCurrentIp') {
    const pure =
      op.kind === 'acceptTest'
        ? validateAcceptTest(prev, op.key, op.revision)
        : validateAcceptCurrentIp(prev, op.revision);
    if (pure !== 'ok') return finish(prev, { ok: false, error: 'stale-route', code: 'stale-route', opId });
    if (chrome.proxy?.settings) {
      let owned = false;
      try {
        owned = (await chrome.proxy.settings.get({})).levelOfControl === 'controlled_by_this_extension';
      } catch {
        owned = false;
      }
      if (op.kind === 'acceptTest' || expectsOwnership(prev)) {
        if (!owned) return finish(prev, { ok: false, error: 'not-owned', code: 'not-owned', opId });
      }
    }
    return finish(computeNextState(prev, op), { ok: true, opId });
  }

  const next = computeNextState(prev, op);
  if (!opNeedsRouting(op) || !chrome.proxy?.settings) {
    return finish(next, { ok: true, opId });
  }
  try {
    await applyStateToBrowser(next);
  } catch (e) {
    const kind =
      typeof e === 'object' && e !== null && 'kind' in e
        ? ((e as { kind: unknown }).kind as 'other-extension' | 'policy' | 'rejected')
        : 'rejected';
    // Roll back the configuration — but NEVER rewind the revision: the failed
    // route may already have been installed briefly, so restoring the old
    // revision would make that interval invisible to test acceptance. The
    // rollback therefore carries a fresh revision and drops cached results.
    const rollbackRev = Math.max(prev.routingRevision ?? 0, next.routingRevision ?? 0) + 1;
    const rolledBack = { ...prev, routingRevision: rollbackRev, tests: {}, currentIp: null };
    try {
      await applyStateToBrowser(prev);
    } catch {
      /* original failure is what matters */
    }
    const k = (typeof kind === 'string' ? kind : 'rejected') as
      | 'other-extension'
      | 'policy'
      | 'rejected';
    return finish(rolledBack, { ok: false, error: k, kind: k, opId });
  }
  return finish(next, { ok: true, opId });
}

// --- Auth: route-aware, HTTP/HTTPS-only, retry-bounded ---

/** requestId -> number of proxy challenges already answered. */
const authAttempts = new Map<string, number>();
const MAX_AUTH_ATTEMPTS_PER_REQUEST = 1;
/**
 * Bound for tracked request IDs (memory hygiene). Exhausted markers are
 * retained — never timer-renewed — so only extreme pressure evicts the oldest
 * entry; completion/error events are the normal cleanup path.
 */
const MAX_AUTH_TRACKED_REQUESTS = 1000;

function trackAttempt(requestId?: string): number {
  if (!requestId) return 1;
  const n = (authAttempts.get(requestId) ?? 0) + 1;
  authAttempts.set(requestId, n);
  // Deliberately no timer cleanup: deleting the record after N seconds would
  // hand a still-live request a fresh budget. The exhausted marker stays until
  // completion/error (or LRU eviction under extreme pressure).
  if (authAttempts.size > MAX_AUTH_TRACKED_REQUESTS) {
    const oldest = authAttempts.keys().next().value as string | undefined;
    if (oldest !== undefined) authAttempts.delete(oldest);
  }
  return n;
}

function clearAttempt(requestId?: string): void {
  if (requestId) authAttempts.delete(requestId);
}

function requestHostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

async function isOwnedByUs(): Promise<boolean> {
  try {
    if (!chrome.proxy?.settings) return false;
    const cur = await chrome.proxy.settings.get({});
    return cur.levelOfControl === 'controlled_by_this_extension';
  } catch {
    return false;
  }
}

async function getActiveCredentials(): Promise<StoredProfile | null> {
  const { activeId, profiles } = await readStore();
  if (!activeId) return null;
  const p = profiles.find((x) => x.id === activeId) ?? null;
  if (!p || (p.protocol !== 'http' && p.protocol !== 'https') || !p.username) return null;
  return p;
}

/**
 * Credentials for the proxy issuing this challenge:
 * - only when this extension currently owns proxy routing,
 * - only HTTP/HTTPS profiles with a username,
 * - only profiles that actually route traffic (active or enabled rule target),
 * - preferring the rule target for the requesting URL on same-endpoint ties.
 */
async function getChallengeCredentials(
  host: string,
  port: number,
  requestHost?: string,
): Promise<StoredProfile | null> {
  const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const state = migrateState(raw);
  const hit = selectAuthCandidate(
    {
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
      rules: state.rules,
      rulesEnabled: state.rulesEnabled,
    },
    host,
    port,
    requestHost,
  );
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name,
    protocol: hit.protocol,
    host: hit.host,
    port: hit.port,
    username: hit.username,
    password: hit.password,
  };
}

function handleAuthRequired(
  details: chrome.webRequest.OnAuthRequiredDetails,
  asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void,
): chrome.webRequest.BlockingResponse | undefined {
  // Only answer proxy challenges, never origin-server challenges.
  if (!asyncCallback) return undefined;
  if (!details.isProxy) {
    asyncCallback({});
    return undefined;
  }
  // Bound retries: an invalid password re-challenges the same requestId.
  // Answer at most once per request; afterwards let the browser prompt/fail
  // instead of looping forever on bad credentials.
  const attempt = trackAttempt(details.requestId);
  if (attempt > MAX_AUTH_ATTEMPTS_PER_REQUEST) {
    asyncCallback({});
    return undefined;
  }
  void (async () => {
    try {
      if (!(await isOwnedByUs())) {
        asyncCallback({});
        return;
      }
      const challenger = details.challenger;
      const requestHost = requestHostOf(details.url);
      let creds: StoredProfile | null = null;
      if (challenger && challenger.host) {
        creds = await getChallengeCredentials(challenger.host, challenger.port, requestHost);
      } else {
        creds = await getActiveCredentials();
      }
      // Consistency guard: when the request URL is known, the challenger must
      // be the PAC-resolved route for it (same semantics as routing itself,
      // including missing-target fallback to the default and built-in
      // bypasses). This prevents leaking creds to an unexpected proxy while
      // still serving the default proxy when a rule target was deleted.
      if (creds && requestHost) {
        const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>;
        const st = migrateState(raw);
        const expectedId = resolveTargetForHost(
          {
            profiles: st.profiles,
            activeProfileId: st.activeProfileId,
            rules: st.rules,
            rulesEnabled: st.rulesEnabled,
          },
          requestHost,
        );
        if (expectedId === null || creds.id !== expectedId) {
          asyncCallback({});
          return;
        }
      }
      // NOTE: never log username/password here.
      if (creds?.username) {
        asyncCallback({
          authCredentials: { username: creds.username, password: creds.password ?? '' },
        });
      } else {
        asyncCallback({});
      }
    } catch {
      asyncCallback({});
    }
  })();
  return undefined;
}

function ensureAuthListener(): void {
  if (!hasApis()) return;
  if (chrome.webRequest.onAuthRequired.hasListener(handleAuthRequired)) return;
  try {
    chrome.webRequest.onAuthRequired.addListener(handleAuthRequired, { urls: ['<all_urls>'] }, [
      'asyncBlocking',
    ]);
  } catch {
    /* e.g. permission missing in dev — proxy still switches, auth prompts manually */
  }
  // Cleanup retry counters when requests finish (typed registration with the
  // required URL filter — the webRequest contract requires it).
  try {
    const filter = { urls: ['<all_urls>'] };
    if (chrome.webRequest.onCompleted?.addListener) {
      chrome.webRequest.onCompleted.addListener(
        (d: { requestId?: string }) => clearAttempt(d.requestId),
        filter,
      );
    }
    if (chrome.webRequest.onErrorOccurred?.addListener) {
      chrome.webRequest.onErrorOccurred.addListener(
        (d: { requestId?: string }) => clearAttempt(d.requestId),
        filter,
      );
    }
  } catch {
    /* e.g. stripped-down test double — the fallback timer still bounds retries */
  }
}

function routingActive(r: Routing): boolean {
  if (r.activeId !== null) return true;
  return (
    r.rulesEnabled && r.rules.some((x) => x.enabled && x.targetProfileId !== null)
  );
}

async function syncBadge(): Promise<void> {
  try {
    if (!chrome.action?.setBadgeText) return;
    const routing = await readStore();
    if (routingActive(routing)) {
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    /* badge is best-effort */
  }
}

async function reapplyActiveProfile(): Promise<void> {
  try {
    const routing = await readStore();
    const { activeId, profiles, rules, rulesEnabled } = routing;
    const pacMode = rulesEnabled && rules.some((r) => r.enabled);
    if ((!activeId && !pacMode) || !chrome.proxy?.settings) {
      await syncBadge();
      return;
    }
    const current = await chrome.proxy.settings.get({});
    if (current.levelOfControl === 'controlled_by_this_extension') {
      await syncBadge();
      return; // already ours
    }
    if (
      current.levelOfControl === 'controlled_by_other_extensions' ||
      current.levelOfControl === 'not_controllable'
    ) {
      return; // conflict or policy — popup explains; never fight it
    }
    if (pacMode) {
      await chrome.proxy.settings.set({
        value: {
          mode: 'pac_script',
          pacScript: { data: buildPacScript(rules, profiles, activeId), mandatory: true },
        },
        scope: 'regular',
      });
      await syncBadge();
      return;
    }
    const active = profiles.find((p) => p.id === activeId);
    if (!active) return;
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: active.protocol, host: active.host, port: active.port },
          bypassList: ['localhost', '127.0.0.1', '<local>'],
        },
      },
      scope: 'regular',
    });
    await syncBadge();
  } catch {
    /* best effort on startup */
  }
}

ensureAuthListener();

chrome.runtime?.onInstalled?.addListener((details) => {
  ensureAuthListener();
  if (details.reason === 'install' && chrome.tabs?.create) {
    // First-run onboarding (single screen, no marketing flow).
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
  }
  if (details.reason === 'update') {
    // Never erase data on update; popup migration runs on next read.
    void syncBadge();
  }
});

chrome.runtime?.onStartup?.addListener(() => {
  ensureAuthListener();
  void reapplyActiveProfile();
});

chrome.runtime?.onMessage?.addListener(
  (
    msg: { type?: string; op?: MutationOp; opId?: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ) => {
    // Popup notifies us after switching so the (possibly restarted) worker
    // re-arms the auth handler. No credentials travel in the message itself —
    // the handler always reads them from storage.
    if (msg?.type === 'proxy-applied' || msg?.type === 'proxy-cleared') {
      ensureAuthListener();
      return undefined;
    }
    if (msg?.type === 'onlyproxy:mutate' && msg.op) {
      // Always answer, including on storage/internal failure — a pending
      // caller otherwise falls back to an unsafe local replay.
      void handleMutate(msg.op, msg.opId).then(
        (r) => sendResponse(r),
        () => sendResponse({ ok: false, error: 'storage-failed', code: 'storage', opId: msg.opId }),
      );
      return true;
    }
    return undefined;
  },
);

export {};
