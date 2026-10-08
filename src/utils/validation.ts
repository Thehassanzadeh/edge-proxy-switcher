import type { ProxyProfile } from '../types';

const HOST_RE = /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\])$/;

export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return 'Host is required.';
  if (h.length > 255) return 'Host is too long.';
  if (/\s/.test(h)) return 'Host must not contain spaces.';
  // Bracketed IPv6, e.g. [::1] — allowed; colons inside brackets are fine.
  if (h.startsWith('[') && h.endsWith(']')) {
    try {
      // The URL parser validates IPv6 compression, group sizes and embedded IPv4.
      if (new URL(`http://${h}/`).hostname.startsWith('[')) return null;
    } catch {
      // Invalid IPv6 literal.
    }
    return 'Invalid IPv6 address. Use brackets, e.g. [::1].';
  }
  if (h.includes('@') || h.includes('/') || h.includes(':')) {
    return 'Host must be a plain hostname or IP (no scheme, port, or credentials).';
  }
  if (!HOST_RE.test(h)) return 'Enter a valid hostname or IP address.';
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && v4.slice(1).some((o) => Number(o) > 255)) {
    return 'Invalid IPv4 address.';
  }
  return null;
}

export function validatePort(port: number): string | null {
  if (!Number.isInteger(port)) return 'Port must be an integer.';
  if (port < 1 || port > 65535) return 'Port must be between 1 and 65535.';
  return null;
}

export function validateProfile(p: Pick<ProxyProfile, 'name' | 'host' | 'port'>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!p.name.trim()) errors.name = 'Name is required.';
  else if (p.name.trim().length > 60) errors.name = 'Name is too long (max 60).';
  const h = validateHost(p.host);
  if (h) errors.host = h;
  const pt = validatePort(p.port);
  if (pt) errors.port = pt;
  return errors;
}

/** Mask host for privacy when showIp is off: 185.xxx.xxx.xxx style. */
export function maskHost(host: string): string {
  const h = host.trim();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const first = h.split('.')[0];
    return `${first}.xxx.xxx.xxx`;
  }
  if (h.length <= 4) return '••••';
  return `${h.slice(0, 2)}••••${h.slice(-2)}`;
}
