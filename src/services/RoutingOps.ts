import { MAX_RECENT, type ExtensionState, type ProxyProfile, type SiteRule, type StoredTest } from '../types';
import { findMatchingRule } from '../utils/siteRules';

export const APP_NAME = 'OnlyProxy';

/** True when PAC routing is in effect (master on + at least one enabled rule). */
export function shouldUsePac(state: Pick<ExtensionState, 'rulesEnabled' | 'rules'>): boolean {
  return state.rulesEnabled && state.rules.some((r) => r.enabled);
}

/** Badge/ON state: any global proxy or any enabled rule with a proxy target. */
export function isRoutingActive(state: Pick<ExtensionState, 'activeProfileId' | 'rules' | 'rulesEnabled'>): boolean {
  if (state.activeProfileId !== null) return true;
  return (
    state.rulesEnabled && state.rules.some((r) => r.enabled && r.targetProfileId !== null)
  );
}

/**
 * True when the extension intends to control proxy routing (global profile
 * and/or any enabled site rule). Used for ownership gating: when true the
 * browser must report `controlled_by_this_extension`, otherwise a test result
 * or credential answer must be discarded.
 */
export function expectsOwnership(state: Pick<ExtensionState, 'activeProfileId' | 'rules' | 'rulesEnabled'>): boolean {
  if (state.activeProfileId !== null) return true;
  return state.rulesEnabled && state.rules.some((r) => r.enabled);
}

/**
 * Resolve which profile (by id) handles `host` under `state`, or null for Direct.
 * Mirrors buildPacScript: built-in bypasses are always direct; first enabled
 * matching rule wins; missing rule targets fall back to the default; default is
 * the global profile or Direct.
 */
export function resolveTargetForHost(
  state: Pick<ExtensionState, 'rules' | 'rulesEnabled' | 'profiles' | 'activeProfileId'>,
  host: string,
): string | null {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return null;
  if (shouldUsePac(state)) {
    const rule = state.rules.find((r) => {
      if (!r.enabled) return false;
      const p = r.pattern;
      if (p.startsWith('*.')) {
        const suffix = p.slice(1);
        return h.length > suffix.length && h.endsWith(suffix);
      }
      return h === p;
    });
    if (rule) {
      if (rule.targetProfileId === null) return null;
      const exists = state.profiles.some((p) => p.id === rule.targetProfileId);
      if (exists) return rule.targetProfileId;
      // Missing target falls back to the default (same as PAC builder).
      return state.activeProfileId;
    }
  }
  return state.activeProfileId;
}

export function endpointKey(host: string, port: number): string {
  return `${host.toLowerCase()}#${port}`;
}

function isHttpAuthable(p: Pick<ProxyProfile, 'protocol' | 'username'>): boolean {
  return (p.protocol === 'http' || p.protocol === 'https') && !!p.username;
}

/**
 * Choose credentials for a proxy challenge.
 *
 * Rules (in order):
 * 1. Only HTTP/HTTPS profiles with a username are eligible (SOCKS is ignored
 *    by Chromium and must never be supplied).
 * 2. The challenger endpoint (host+port) must match.
 * 3. Among endpoint matches, prefer the profile that actually routes the
 *    requesting URL: the enabled rule matching `requestHost` (if known),
 *    otherwise the active profile, otherwise the first enabled rule target in
 *    priority order.
 * 4. Profiles that are neither active nor an enabled rule target are never
 *    used — this fixes the "inactive same-endpoint account wins" bug.
 * 5. Returns null when ambiguous or inapplicable instead of guessing.
 */
export function selectAuthCandidate(
  state: Pick<ExtensionState, 'profiles' | 'activeProfileId' | 'rules' | 'rulesEnabled'>,
  challengerHost: string,
  challengerPort: number,
  requestHost?: string,
): ProxyProfile | null {
  const h = challengerHost.toLowerCase();
  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  const endpointMatches = state.profiles.filter(
    (p) => p.host.toLowerCase() === h && p.port === challengerPort && isHttpAuthable(p),
  );
  if (endpointMatches.length === 0) return null;

  const ruleTargets = new Set<string>();
  if (state.rulesEnabled) {
    for (const r of state.rules) {
      if (r.enabled && r.targetProfileId !== null) ruleTargets.add(r.targetProfileId);
    }
  }
  const isRouted = (id: string): boolean =>
    id === state.activeProfileId || ruleTargets.has(id);
  const routed = endpointMatches.filter((p) => isRouted(p.id));
  if (routed.length === 0) return null;

  // Prefer the rule that routes the requesting URL (PAC semantics).
  if (requestHost) {
    const rule = findMatchingRule(
      state.rulesEnabled ? state.rules : [],
      requestHost,
    );
    if (rule && rule.targetProfileId !== null) {
      const t = byId.get(rule.targetProfileId);
      if (t && t.host.toLowerCase() === h && t.port === challengerPort && isHttpAuthable(t)) {
        return t;
      }
      // A Direct rule (or a missing target falling back elsewhere) means this
      // challenger is not the expected route — do not supply other creds.
      if (rule.targetProfileId === null) return null;
    } else if (rule && rule.targetProfileId === null) {
      return null;
    } else {
      // No rule matched: the default (active) profile handles it.
      const active = state.activeProfileId ? byId.get(state.activeProfileId) : undefined;
      if (
        active &&
        active.host.toLowerCase() === h &&
        active.port === challengerPort &&
        isHttpAuthable(active)
      ) {
        return active;
      }
      return null;
    }
  }

  // No request host known: prefer active, then first rule target by priority.
  if (state.activeProfileId) {
    const active = routed.find((p) => p.id === state.activeProfileId);
    if (active) return active;
  }
  if (state.rulesEnabled) {
    for (const r of state.rules) {
      if (!r.enabled || r.targetProfileId === null) continue;
      const hit = routed.find((p) => p.id === r.targetProfileId);
      if (hit) return hit;
    }
  }
  // Single remaining routed candidate (e.g. PAC disabled, active is the only
  // routed profile) — safe to use. Multiple ambiguous routed candidates with
  // no request context: do not guess.
  if (routed.length === 1) return routed[0];
  const activeFallback = state.activeProfileId
    ? (byId.get(state.activeProfileId) ?? null)
    : null;
  if (
    activeFallback &&
    activeFallback.host.toLowerCase() === h &&
    activeFallback.port === challengerPort &&
    isHttpAuthable(activeFallback)
  ) {
    return activeFallback;
  }
  return null;
}

// --- State transitions (pure; callers persist + apply routing) ---

export type MutationOp =
  | { kind: 'activate'; id: string | null }
  | { kind: 'upsert'; profile: ProxyProfile }
  | { kind: 'delete'; id: string }
  | { kind: 'addMany'; profiles: ProxyProfile[]; favoriteIds: string[] }
  | { kind: 'replace'; profiles: ProxyProfile[]; favoriteIds: string[] }
  | { kind: 'rules'; rules: SiteRule[]; rulesEnabled: boolean }
  | { kind: 'ruleAdd'; rule: SiteRule }
  | { kind: 'ruleDelete'; id: string }
  | { kind: 'rulePatch'; id: string; patch: Partial<Pick<SiteRule, 'pattern' | 'targetProfileId' | 'enabled'>> }
  | { kind: 'ruleMove'; id: string; dir: -1 | 1 }
  | { kind: 'rulesEnabled'; enabled: boolean }
  | { kind: 'favorite'; id: string; favorite: boolean }
  | { kind: 'settings'; patch: Partial<ExtensionState['settings']> }
  | { kind: 'saveTest'; key: string; test: StoredTest }
  | { kind: 'saveCurrentIp'; test: StoredTest }
  | { kind: 'acceptTest'; key: string; test: StoredTest; revision: number }
  | { kind: 'acceptCurrentIp'; test: StoredTest; revision: number };

function cloneState(prev: ExtensionState): ExtensionState {
  return {
    ...prev,
    settings: { ...prev.settings },
    profiles: prev.profiles.map((p) => ({ ...p })),
    favoriteIds: [...prev.favoriteIds],
    recentIds: [...prev.recentIds],
    rules: prev.rules.map((r) => ({ ...r })),
    tests: { ...prev.tests },
  };
}

function withoutTest(
  tests: Record<string, StoredTest>,
  key: string,
): Record<string, StoredTest> {
  const { [key]: _drop, ...rest } = tests;
  return rest;
}

/**
 * Apply `op` to a fresh `prev` snapshot. Routing-affecting ops also invalidate
 * `currentIp` (stale route) and the affected per-profile tests so old
 * "Verified" badges cannot survive a config change, and bump `routingRevision`
 * so in-flight connection checks can be recognized as stale.
 *
 * NOTE: `acceptTest`/`acceptCurrentIp` perform no validation here — the
 * mutation owner must run `validateAcceptTest`/`validateAcceptCurrentIp` (plus
 * an ownership check) immediately before, atomically with the write.
 */
export function computeNextState(prev: ExtensionState, op: MutationOp): ExtensionState {
  const next = transition(prev, op);
  if (opNeedsRouting(op)) {
    next.routingRevision = (prev.routingRevision ?? 0) + 1;
  }
  return next;
}

function transition(prev: ExtensionState, op: MutationOp): ExtensionState {
  const next = cloneState(prev);
  switch (op.kind) {
    case 'activate': {
      next.activeProfileId = op.id;
      if (op.id !== null) {
        next.recentIds = [op.id, ...next.recentIds.filter((id) => id !== op.id)].slice(
          0,
          MAX_RECENT,
        );
      }
      // The previous current-connection check is no longer this route.
      next.currentIp = null;
      return next;
    }
    case 'upsert': {
      const i = next.profiles.findIndex((p) => p.id === op.profile.id);
      if (i >= 0) next.profiles[i] = { ...op.profile };
      else next.profiles.push({ ...op.profile });
      // Old verification for this profile is stale once its config changes.
      next.tests = withoutTest(next.tests, op.profile.id);
      const touchesRouting =
        next.activeProfileId === op.profile.id ||
        next.rules.some((r) => r.enabled && r.targetProfileId === op.profile.id);
      if (touchesRouting) next.currentIp = null;
      return next;
    }
    case 'delete': {
      next.profiles = next.profiles.filter((p) => p.id !== op.id);
      next.favoriteIds = next.favoriteIds.filter((id) => id !== op.id);
      next.recentIds = next.recentIds.filter((id) => id !== op.id);
      next.tests = withoutTest(next.tests, op.id);
      if (next.activeProfileId === op.id) next.activeProfileId = null;
      // Rules keep their (now missing) target and fall back to the default in
      // the PAC script; the routing still changed, so drop the current-IP.
      next.currentIp = null;
      return next;
    }
    case 'addMany': {
      next.profiles = [...next.profiles, ...op.profiles.map((p) => ({ ...p }))];
      next.favoriteIds = [...next.favoriteIds, ...op.favoriteIds];
      return next;
    }
    case 'replace': {
      next.profiles = op.profiles.map((p) => ({ ...p }));
      next.favoriteIds = [...op.favoriteIds];
      next.recentIds = [];
      next.tests = {};
      next.currentIp = null;
      const ids = new Set(next.profiles.map((p) => p.id));
      if (next.activeProfileId !== null && !ids.has(next.activeProfileId)) {
        next.activeProfileId = null;
      }
      // Rules pointing at vanished profiles fall back to the default (PAC).
      return next;
    }
    case 'rules': {
      next.rules = op.rules.map((r) => ({ ...r }));
      next.rulesEnabled = op.rulesEnabled;
      // Any prior test may have run under different routing — invalidate.
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'ruleAdd': {
      if (!next.rules.some((r) => r.id === op.rule.id)) {
        next.rules = [...next.rules, { ...op.rule }];
      }
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'ruleDelete': {
      next.rules = next.rules.filter((r) => r.id !== op.id);
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'rulePatch': {
      next.rules = next.rules.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r));
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'ruleMove': {
      const i = next.rules.findIndex((r) => r.id === op.id);
      const j = i + op.dir;
      if (i >= 0 && j >= 0 && j < next.rules.length) {
        const arr = [...next.rules];
        [arr[i], arr[j]] = [arr[j], arr[i]];
        next.rules = arr;
      }
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'rulesEnabled': {
      next.rulesEnabled = op.enabled;
      next.tests = {};
      next.currentIp = null;
      return next;
    }
    case 'favorite': {
      next.favoriteIds = op.favorite
        ? [...new Set([...next.favoriteIds, op.id])]
        : next.favoriteIds.filter((id) => id !== op.id);
      return next;
    }
    case 'settings': {
      next.settings = { ...next.settings, ...op.patch };
      return next;
    }
    case 'saveTest': {
      next.tests = { ...next.tests, [op.key]: op.test };
      return next;
    }
    case 'saveCurrentIp': {
      next.currentIp = op.test;
      return next;
    }
    case 'acceptTest': {
      // Owner-validated only (see computeNextState note). Stamp the verified
      // revision so later readers can tell what this result was checked against.
      next.tests = { ...next.tests, [op.key]: { ...op.test, rev: op.revision } };
      return next;
    }
    case 'acceptCurrentIp': {
      next.currentIp = { ...op.test, rev: op.revision };
      return next;
    }
  }
}

/**
 * Pure (ownership-independent) half of connection-test acceptance.
 * The owner must additionally verify proxy ownership when extension APIs are
 * present. Returns 'ok' only when the result is still attributable to `key`.
 */
export function validateAcceptTest(
  state: ExtensionState,
  key: string,
  revision: number,
): 'ok' | 'stale-route' {
  if ((state.routingRevision ?? 0) !== revision) return 'stale-route';
  if (!state.profiles.some((p) => p.id === key)) return 'stale-route';
  if (resolveTargetForHost(state, 'api.ipify.org') !== key) return 'stale-route';
  return 'ok';
}

/** Revision-only half of current-connection acceptance (no profile claim). */
export function validateAcceptCurrentIp(
  state: ExtensionState,
  revision: number,
): 'ok' | 'stale-route' {
  if ((state.routingRevision ?? 0) !== revision) return 'stale-route';
  return 'ok';
}

/** True when `op` can change browser routing and needs a proxy apply attempt. */
export function opNeedsRouting(op: MutationOp): boolean {
  return (
    op.kind === 'activate' ||
    op.kind === 'upsert' ||
    op.kind === 'delete' ||
    op.kind === 'replace' ||
    op.kind === 'rules' ||
    op.kind === 'ruleAdd' ||
    op.kind === 'ruleDelete' ||
    op.kind === 'rulePatch' ||
    op.kind === 'ruleMove' ||
    op.kind === 'rulesEnabled'
  );
}
