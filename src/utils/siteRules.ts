import type { ProxyProfile, SiteRule } from '../types';
import { validateHost } from './validation';

/** Built-in bypasses, always DIRECT (not user-editable). */
export const DEFAULT_BYPASS_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Valid patterns: exact hostname/IP ("chatgpt.com", "1.2.3.4", "[::1]")
 * or leading-wildcard ("*.example.com", matches subdomains only).
 * Returns null when valid, otherwise the error message.
 */
export function validateSitePattern(raw: string): string | null {
  const pattern = raw.trim().toLowerCase();
  if (!pattern) return 'Pattern is required.';
  if (pattern.length > 255) return 'Pattern is too long.';
  if (/\s/.test(pattern)) return 'Pattern must not contain spaces.';
  if (pattern.includes('/')) return 'Enter a domain only, no scheme, port, or path.';
  if (pattern.startsWith('*.')) {
    const rest = pattern.slice(2);
    if (!rest || rest.startsWith('*')) return 'Use one leading wildcard, e.g. *.example.com.';
    const err = validateHost(rest);
    if (err) return err;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest) || rest.startsWith('[')) {
      return 'Wildcards only apply to domain names, not IP addresses.';
    }
    return null;
  }
  if (pattern.includes('*')) return 'Wildcard is only supported as a leading *., e.g. *.example.com.';
  return validateHost(pattern);
}

/** Normalize for storage: trim + lowercase. */
export function normalizeSitePattern(raw: string): string {
  return raw.trim().toLowerCase();
}

function isWildcard(pattern: string): boolean {
  return pattern.startsWith('*.');
}

/**
 * Pure JS mirror of the PAC matching (for preview/tests).
 * Exact patterns match that host only; *.example.com matches subdomains only
 * (apex NOT included — same as PAC shExpMatch).
 */
export function matchSitePattern(pattern: string, host: string): boolean {
  const h = host.trim().toLowerCase();
  if (isWildcard(pattern)) {
    const suffix = pattern.slice(1); // ".example.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return h === pattern;
}

/** First enabled matching rule wins (array order = priority). */
export function findMatchingRule(rules: SiteRule[], host: string): SiteRule | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchSitePattern(rule.pattern, host)) return rule;
  }
  return null;
}

/** PAC proxy token for a profile. DIRECT fallback is intentionally omitted
 *  (fail-closed, same as fixed_servers singleProxy behavior). */
export function pacTokenFor(profile: ProxyProfile): string {
  const target = `${profile.host}:${profile.port}`;
  switch (profile.protocol) {
    case 'http':
      return `PROXY ${target}`;
    case 'https':
      return `HTTPS ${target}`;
    case 'socks4':
      return `SOCKS ${target}`;
    case 'socks5':
      return `SOCKS5 ${target}`;
  }
}

function pacEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds the PAC script. Order: built-in bypasses -> enabled rules (priority
 * order) -> default (global profile token, or DIRECT when global is Direct).
 * Rule targets that no longer exist resolve to the default.
 */
export function buildPacScript(
  rules: SiteRule[],
  profiles: ProxyProfile[],
  defaultProfileId: string | null,
): string {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const defaultProfile = defaultProfileId ? (byId.get(defaultProfileId) ?? null) : null;
  const defaultToken = defaultProfile ? pacTokenFor(defaultProfile) : 'DIRECT';

  const lines: string[] = [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  // Built-in bypasses (always direct)',
    `  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "DIRECT";`,
  ];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const target =
      rule.targetProfileId === null ? null : (byId.get(rule.targetProfileId) ?? 'missing');
    const token = target === null ? 'DIRECT' : target === 'missing' ? defaultToken : pacTokenFor(target);
    const condition = isWildcard(rule.pattern)
      ? `shExpMatch(host, "${pacEscape(rule.pattern)}")`
      : `host === "${pacEscape(rule.pattern)}"`;
    lines.push(`  if (${condition}) return "${token}";`);
  }
  lines.push(`  return "${defaultToken}";`, '}');
  return lines.join('\n');
}

/** Human-readable target label for the rule list. */
export function ruleTargetLabel(
  rule: SiteRule,
  profiles: ProxyProfile[],
): { label: string; missing: boolean } {
  if (rule.targetProfileId === null) return { label: 'Direct', missing: false };
  const p = profiles.find((x) => x.id === rule.targetProfileId);
  if (!p) return { label: 'Target deleted — uses default', missing: true };
  return { label: p.name, missing: false };
}
