export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyProfile {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  /** Optional. Only sent for HTTP/HTTPS proxies (see README for SOCKS5 limits). */
  username?: string;
  /** Optional. Never logged; stored locally via chrome.storage. */
  password?: string;
}

export type ThemePref = 'light' | 'dark' | 'system';

/** Persisted result of the last manual test for a profile / connection. */
export interface StoredTest {
  ok: boolean;
  ip?: string;
  latencyMs?: number;
  /** epoch ms of the test */
  at: number;
  /** machine-readable cause: timeout | unreachable | ip-service | rejected | config */
  cause?: string;
  /** technical detail for the expandable section (never credentials) */
  detail?: string;
  /** routing revision this result was verified against (see ExtensionState) */
  rev?: number;
}

export interface AppSettings {
  theme: ThemePref;
  showIp: boolean;
  confirmDelete: boolean;
}

/**
 * Site-specific routing rule.
 * - pattern: exact hostname ("chatgpt.com") or wildcard ("*.example.com",
 *   matches subdomains only — not the apex, per PAC shExpMatch semantics).
 * - targetProfileId: profile id, or null = Direct Connection.
 * - order is array position; index 0 = highest priority.
 */
export interface SiteRule {
  id: string;
  pattern: string;
  targetProfileId: string | null;
  enabled: boolean;
}

/**
 * Versioned single-object store (storage key: "state").
 * Bump SCHEMA_VERSION + add a migration in migrateState() when changing shape.
 */
export interface ExtensionState {
  schemaVersion: number;
  /** activeProfileId: profile id, or null = Direct Connection */
  activeProfileId: string | null;
  profiles: ProxyProfile[];
  favoriteIds: string[];
  /** most-recently-activated profile ids, newest first (max 4) */
  recentIds: string[];
  /** site rules in priority order (index 0 wins); master switch below */
  rules: SiteRule[];
  rulesEnabled: boolean;
  /**
   * Monotonic routing revision. Incremented by every routing- or
   * credential-affecting mutation (activate/profile edits/deletes/replace,
   * all rule changes). Connection-test results carry the revision they were
   * verified against and are only accepted when it still matches, so an
   * intervening edit (including change-away-and-back) invalidates them.
   */
  routingRevision: number;
  /** profileId (or "direct") -> last manual test */
  tests: Record<string, StoredTest>;
  /** cached current-connection IP check */
  currentIp: StoredTest | null;
  settings: AppSettings;
}

export const SCHEMA_VERSION = 3;
export const MAX_RECENT = 4;

export const DEFAULT_STATE: ExtensionState = {
  schemaVersion: SCHEMA_VERSION,
  activeProfileId: null,
  profiles: [],
  favoriteIds: [],
  recentIds: [],
  rules: [],
  rulesEnabled: false,
  routingRevision: 0,
  tests: {},
  currentIp: null,
  settings: {
    theme: 'system',
    showIp: true,
    confirmDelete: true,
  },
};

export interface TestResult {
  ok: boolean;
  ip?: string;
  latencyMs?: number;
  error?: string;
}

export const PROTOCOLS: { value: ProxyProtocol; label: string; defaultPort: number }[] = [
  { value: 'http', label: 'HTTP', defaultPort: 8080 },
  { value: 'https', label: 'HTTPS', defaultPort: 8080 },
  { value: 'socks4', label: 'SOCKS4', defaultPort: 1080 },
  { value: 'socks5', label: 'SOCKS5', defaultPort: 1080 },
];

export function newProfileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `p_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

/** "2 minutes ago" style relative time; falls back to clock time. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  return new Date(at).toLocaleString();
}
