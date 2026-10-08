import { newProfileId, type ProxyProfile } from '../types';
import { parseBulkImport } from './bulkImport';
import { validateProfile } from './validation';

export interface ExportOptions {
  includeCredentials: boolean;
}

/** Serializes profiles + favorites for export. Passwords only when opted in. */
export function buildExportJson(
  profiles: ProxyProfile[],
  favoriteIds: string[],
  opts: ExportOptions,
): string {
  const data = profiles.map((p) => ({
    name: p.name,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    ...(p.username ? { username: p.username } : {}),
    ...(opts.includeCredentials && p.username && p.password ? { password: p.password } : {}),
    ...(favoriteIds.includes(p.id) ? { favorite: true } : {}),
  }));
  return JSON.stringify(data, null, 2);
}

export interface ImportedDraft {
  profile: ProxyProfile;
  favorite: boolean;
}

export interface ImportParseResult {
  valid: ImportedDraft[];
  /** row index (0-based) -> reason, for the invalid-rows display */
  invalid: { index: number; reason: string }[];
}

/**
 * Pure validation gate for JSON import. Returns valid drafts + per-row reasons
 * WITHOUT touching stored data, so callers can preview before applying.
 */
export function parseImportJson(text: string): ImportParseResult {
  const result: ImportParseResult = { valid: [], invalid: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: [], invalid: [{ index: -1, reason: 'Not valid JSON.' }] };
  }
  if (!Array.isArray(parsed)) {
    return { valid: [], invalid: [{ index: -1, reason: 'Expected a JSON array of profiles.' }] };
  }
  parsed.forEach((item, index) => {
    const o = item as Record<string, unknown>;
    if (!o || typeof o !== 'object') {
      result.invalid.push({ index, reason: 'Row is not an object.' });
      return;
    }
    const host = typeof o.host === 'string' ? o.host : '';
    const port = typeof o.port === 'number' ? o.port : NaN;
    if (o.protocol !== undefined && !['http', 'https', 'socks4', 'socks5'].includes(o.protocol as string)) {
      result.invalid.push({ index, reason: 'Unsupported proxy protocol.' });
      return;
    }
    const protocol =
      o.protocol === 'http' || o.protocol === 'https' || o.protocol === 'socks4' || o.protocol === 'socks5'
        ? o.protocol
        : 'http';
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `${host}:${Number.isInteger(port) ? port : '?'}`;
    const errors = validateProfile({ name, host, port });
    const first = errors.name ?? errors.host ?? errors.port;
    if (first) {
      result.invalid.push({ index, reason: first });
      return;
    }
    const username = typeof o.username === 'string' ? o.username : '';
    const password = typeof o.password === 'string' ? o.password : '';
    result.valid.push({
      profile: {
        id: newProfileId(),
        name,
        protocol,
        host: host.trim(),
        port,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(username.trim() && password ? { password } : {}),
      },
      favorite: o.favorite === true,
    });
  });
  return result;
}

/**
 * Quick-add: parse a single pasted proxy string and pre-fill the form.
 * Accepts: host:port, host:port:user:pass, user:pass@host:port,
 *          http(s)://..., socks4/5://..., with optional credentials.
 */
export function parseQuickAdd(
  text: string,
): { ok: true; draft: { name: string; protocol: ProxyProfile['protocol']; host: string; port: string; username: string; password: string } } | { ok: false; reason: string } {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'Paste a proxy string first.' };
  if (/\n/.test(t)) return { ok: false, reason: 'Quick-add takes one proxy; use bulk import for lists.' };
  const [item] = parseBulkImport(t, 'http');
  if (!item?.valid || !item.draft) {
    return { ok: false, reason: item?.message ?? 'Could not parse that proxy string.' };
  }
  return {
    ok: true,
    draft: {
      name: item.draft.name,
      protocol: item.draft.protocol,
      host: item.draft.host,
      port: String(item.draft.port),
      username: item.draft.username ?? '',
      password: item.draft.password ?? '',
    },
  };
}
