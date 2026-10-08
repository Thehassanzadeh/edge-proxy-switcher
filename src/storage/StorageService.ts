import {
  DEFAULT_STATE,
  MAX_RECENT,
  SCHEMA_VERSION,
  type AppSettings,
  type ExtensionState,
  type ProxyProfile,
  type StoredTest,
} from '../types';

const K_STATE = 'state';
// Legacy (pre-v1) split keys — read once during migration, then removed.
const K_LEGACY_PROFILES = 'profiles';
const K_LEGACY_SETTINGS = 'settings';

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

/**
 * Pure migration: legacy split keys / partial state -> current ExtensionState.
 * Never throws; never drops profiles.
 */
export function migrateState(raw: unknown): ExtensionState {
  const base: ExtensionState = {
    ...DEFAULT_STATE,
    settings: { ...DEFAULT_STATE.settings },
    profiles: [],
    favoriteIds: [],
    recentIds: [],
    rules: [],
    rulesEnabled: false,
    routingRevision: 0,
    tests: {},
  };

  const legacy = (raw as Record<string, unknown> | null) ?? {};
  // Case 1: already a state object (any version).
  const maybeState = legacy[K_STATE] as Partial<ExtensionState> | undefined;
  // Case 2: legacy split keys at top level (v0).
  const legacyProfiles = legacy[K_LEGACY_PROFILES] as unknown;
  const legacySettings = legacy[K_LEGACY_SETTINGS] as Record<string, unknown> | undefined;

  if (maybeState && typeof maybeState === 'object') {
    if (Array.isArray(maybeState.profiles)) {
      base.profiles = maybeState.profiles.filter(isProfile);
    }
    if (typeof maybeState.activeProfileId === 'string' || maybeState.activeProfileId === null) {
      base.activeProfileId = maybeState.activeProfileId;
    }
    if (Array.isArray(maybeState.favoriteIds)) {
      base.favoriteIds = maybeState.favoriteIds.filter((x): x is string => typeof x === 'string');
    }
    if (Array.isArray(maybeState.recentIds)) {
      base.recentIds = maybeState.recentIds
        .filter((x): x is string => typeof x === 'string')
        .slice(0, MAX_RECENT);
    }
    // v2: site rules (absent in v1 state -> defaults above).
    if (Array.isArray(maybeState.rules)) {
      base.rules = maybeState.rules.filter(isRule);
    }
    if (typeof maybeState.rulesEnabled === 'boolean') {
      base.rulesEnabled = maybeState.rulesEnabled;
    }
    // v3: routing revision (absent in older states -> starts at 0).
    if (typeof maybeState.routingRevision === 'number' && Number.isInteger(maybeState.routingRevision) && maybeState.routingRevision >= 0) {
      base.routingRevision = maybeState.routingRevision;
    }
    if (maybeState.tests && typeof maybeState.tests === 'object') {
      base.tests = maybeState.tests as ExtensionState['tests'];
    }
    if (maybeState.currentIp && typeof maybeState.currentIp === 'object') {
      base.currentIp = maybeState.currentIp as StoredTest;
    }
    if (maybeState.settings && typeof maybeState.settings === 'object') {
      base.settings = { ...base.settings, ...maybeState.settings };
    }
  } else {
    if (Array.isArray(legacyProfiles)) {
      base.profiles = legacyProfiles.filter(isProfile);
    }
    if (legacySettings && typeof legacySettings === 'object') {
      const s = legacySettings as Partial<AppSettings & { activeProfileId: string | null }>;
      if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'system') {
        base.settings.theme = s.theme;
      }
      if (typeof s.showIp === 'boolean') base.settings.showIp = s.showIp;
      if (typeof s.confirmDelete === 'boolean') base.settings.confirmDelete = s.confirmDelete;
      if (typeof s.activeProfileId === 'string' || s.activeProfileId === null) {
        base.activeProfileId = s.activeProfileId;
      }
    }
  }

  // Sanitize cross-references.
  const ids = new Set(base.profiles.map((p) => p.id));
  base.favoriteIds = base.favoriteIds.filter((id) => ids.has(id));
  base.recentIds = base.recentIds.filter((id) => ids.has(id));
  if (base.activeProfileId !== null && !ids.has(base.activeProfileId)) {
    base.activeProfileId = null;
  }
  base.schemaVersion = SCHEMA_VERSION;
  return base;
}

function isProfile(p: unknown): p is ProxyProfile {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.protocol === 'http' || o.protocol === 'https' || o.protocol === 'socks4' || o.protocol === 'socks5') &&
    typeof o.host === 'string' &&
    Number.isInteger(o.port)
  );
}

function isRule(r: unknown): r is ExtensionState['rules'][number] {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pattern === 'string' &&
    (typeof o.targetProfileId === 'string' || o.targetProfileId === null) &&
    typeof o.enabled === 'boolean'
  );
}

async function readRaw(): Promise<Record<string, unknown>> {
  if (hasChromeStorage()) {
    return (await chrome.storage.local.get(null)) as Record<string, unknown>;
  }
  try {
    const raw = localStorage.getItem(`dev:${K_STATE}`);
    return raw ? { [K_STATE]: JSON.parse(raw) } : {};
  } catch {
    return {};
  }
}

let cache: ExtensionState | null = null;

// Serializes read-modify-write cycles inside this JS context so two concurrent
// `update`/`saveState` calls cannot interleave and lose one change. This does
// NOT serialize across popup/options/background contexts — routing mutations
// must go through the background owner (see ProxyService.dispatchOp).
let writeChain: Promise<void> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.catch(() => {}).then(fn);
  // Keep the chain alive even when `run` rejects; callers still see the error.
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export const StorageService = {
  async getState(): Promise<ExtensionState> {
    if (cache) return cache;
    return StorageService.getFreshState();
  },

  /** Bypass the in-memory cache and re-read storage (fresh snapshot). */
  async getFreshState(): Promise<ExtensionState> {
    const raw: Record<string, unknown> = await readRaw();
    const state = migrateState(raw);
    // Persist migrated shape (and drop legacy keys) exactly once.
    if ((raw[K_STATE] as ExtensionState | undefined)?.schemaVersion !== SCHEMA_VERSION) {
      await StorageService.saveState(state, { removeLegacy: true }).catch(() => {});
      return (cache ?? state);
    }
    cache = state;
    return state;
  },

  async saveState(next: ExtensionState, opts?: { removeLegacy?: boolean }): Promise<void> {
    return runExclusive(async () => {
      const payload: Record<string, unknown> = { [K_STATE]: next };
      // Commit before deleting legacy data; a failed write must remain recoverable.
      if (hasChromeStorage()) {
        await chrome.storage.local.set(payload);
      } else {
        localStorage.setItem(`dev:${K_STATE}`, JSON.stringify(next));
      }
      cache = next;
      if (opts?.removeLegacy) {
        if (hasChromeStorage()) {
          await chrome.storage.local.remove([K_LEGACY_PROFILES, K_LEGACY_SETTINGS]);
        } else {
          localStorage.removeItem(`dev:${K_LEGACY_PROFILES}`);
          localStorage.removeItem(`dev:${K_LEGACY_SETTINGS}`);
        }
      }
    });
  },

  /** Functional update helper: mutates a draft copy, persists, returns it. */
  async update(fn: (draft: ExtensionState) => void): Promise<ExtensionState> {
    return runExclusive(async () => {
      const current = cache ?? (await StorageService.getFreshState());
      const draft: ExtensionState = {
        ...current,
        settings: { ...current.settings },
        profiles: [...current.profiles],
        favoriteIds: [...current.favoriteIds],
        recentIds: [...current.recentIds],
        rules: current.rules.map((rule) => ({ ...rule })),
        tests: { ...current.tests },
      };
      fn(draft);
      const payload: Record<string, unknown> = { [K_STATE]: draft };
      if (hasChromeStorage()) {
        await chrome.storage.local.set(payload);
      } else {
        localStorage.setItem(`dev:${K_STATE}`, JSON.stringify(draft));
      }
      cache = draft;
      return draft;
    });
  },

  // --- convenience accessors (kept API-compatible with v0 call sites) ---
  async getProfiles(): Promise<ProxyProfile[]> {
    return (await StorageService.getState()).profiles;
  },
  async saveProfiles(profiles: ProxyProfile[]): Promise<void> {
    await StorageService.update((d) => {
      d.profiles = profiles;
    });
  },
  async getSettings(): Promise<AppSettings & { activeProfileId: string | null }> {
    const s = await StorageService.getState();
    return { ...s.settings, activeProfileId: s.activeProfileId };
  },
  async saveSettings(patch: Partial<AppSettings & { activeProfileId: string | null }>): Promise<void> {
    await StorageService.update((d) => {
      const { activeProfileId, ...rest } = patch;
      d.settings = { ...d.settings, ...rest };
      if (activeProfileId !== undefined) d.activeProfileId = activeProfileId;
    });
  },

  /** Live-sync (popup <-> options). Resets cache so readers see fresh data. */
  onChanged(cb: () => void): () => void {
    if (!hasChromeStorage() || !chrome.storage.onChanged) {
      const onStorage = (e: StorageEvent) => {
        if (e.key?.startsWith('dev:')) {
          cache = null;
          cb();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }
    const listener = (_changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local') {
        cache = null;
        cb();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
};
