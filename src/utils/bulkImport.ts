import { newProfileId, type ProxyProfile, type ProxyProtocol } from '../types';
import { validateHost, validatePort } from './validation';

export interface BulkPreviewItem {
  key: number;
  valid: boolean;
  message?: string;
  draft?: Omit<ProxyProfile, 'id'>;
  raw: string;
}

const SCHEME_MAP: Record<string, ProxyProtocol> = {
  http: 'http',
  https: 'https',
  socks4: 'socks4',
  socks: 'socks5',
  socks5: 'socks5',
};

function checkHostPort(host: string, port: number): string | null {
  return validateHost(host) ?? validatePort(port);
}

/**
 * Recognized formats (one per line):
 *   IP:PORT
 *   IP:PORT:USERNAME:PASSWORD
 *   USERNAME:PASSWORD@IP:PORT
 *   http(s)://IP:PORT  (also socks4://, socks5://, socks://)
 *   socks5://USERNAME:PASSWORD@IP:PORT
 */
export function parseBulkImport(text: string, defaultProtocol: ProxyProtocol): BulkPreviewItem[] {
  const lines = text.split(/\r?\n/);
  const items: BulkPreviewItem[] = [];
  let n = 0;

  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    n += 1;
    const fail = (message: string): BulkPreviewItem => ({ key: n, valid: false, message, raw });

    // scheme://...
    const schemeMatch = raw.match(/^([a-zA-Z0-9]+):\/\/(.+)$/);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      const rest = schemeMatch[2];
      const protocol = SCHEME_MAP[scheme];
      if (!protocol) {
        items.push(fail(`Unknown scheme "${schemeMatch[1]}". Use http, https, socks4 or socks5.`));
        continue;
      }
      // [user:pass@]host:port
      const m = rest.match(/^(?:([^:@/\s]+):([^@/\s]*)@)?([^:@/\s\[\]]+|\[[^\]]+\]):(\d+)\/?$/);
      if (!m) {
        items.push(fail('Expected [user:pass@]host:port after the scheme.'));
        continue;
      }
      const [, user, pass, host, portStr] = m;
      const port = Number(portStr);
      const err = checkHostPort(host, port);
      if (err) {
        items.push(fail(err));
        continue;
      }
      items.push({
        key: n,
        valid: true,
        raw,
        draft: {
          name: `${host}:${port}`,
          protocol,
          host,
          port,
          ...(user ? { username: user } : {}),
          ...(user ? { password: pass ?? '' } : {}),
        },
      });
      continue;
    }

    // user:pass@host:port
    const atMatch = raw.match(/^([^:@\s]+):([^@\s]*)@([^:@\s\[\]]+|\[[^\]]+\]):(\d+)$/);
    if (atMatch) {
      const [, user, pass, host, portStr] = atMatch;
      const port = Number(portStr);
      const err = checkHostPort(host, port);
      if (err) {
        items.push(fail(err));
        continue;
      }
      items.push({
        key: n,
        valid: true,
        raw,
        draft: { name: `${host}:${port}`, protocol: defaultProtocol, host, port, username: user, password: pass },
      });
      continue;
    }

    const parts = raw.split(':');
    if (parts.length === 2) {
      const [host, portStr] = parts;
      const port = Number(portStr);
      if (!Number.isInteger(port)) {
        items.push(fail('Port must be an integer.'));
        continue;
      }
      const err = checkHostPort(host, port);
      if (err) {
        items.push(fail(err));
        continue;
      }
      items.push({ key: n, valid: true, raw, draft: { name: `${host}:${port}`, protocol: defaultProtocol, host, port } });
      continue;
    }
    if (parts.length === 4) {
      const [host, portStr, user, pass] = parts;
      const port = Number(portStr);
      if (!Number.isInteger(port)) {
        items.push(fail('Port must be an integer.'));
        continue;
      }
      const err = checkHostPort(host, port);
      if (err) {
        items.push(fail(err));
        continue;
      }
      if (!user) {
        items.push(fail('Username is empty.'));
        continue;
      }
      items.push({
        key: n,
        valid: true,
        raw,
        draft: { name: `${host}:${port}`, protocol: defaultProtocol, host, port, username: user, password: pass },
      });
      continue;
    }

    items.push(fail('Unrecognized format.'));
  }

  return items;
}

export function toProfiles(items: BulkPreviewItem[], namePrefix = ''): ProxyProfile[] {
  return items
    .filter((i) => i.valid && i.draft)
    .map((i) => ({
      id: newProfileId(),
      name: namePrefix ? `${namePrefix} ${i.draft!.name}` : i.draft!.name,
      protocol: i.draft!.protocol,
      host: i.draft!.host,
      port: i.draft!.port,
      ...(i.draft!.username ? { username: i.draft!.username } : {}),
      ...(i.draft!.username ? { password: i.draft!.password ?? '' } : {}),
    }));
}
