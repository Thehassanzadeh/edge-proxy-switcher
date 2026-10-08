import { describe, expect, it } from 'vitest';
import { buildExportJson, parseImportJson, parseQuickAdd } from './transfer';

const profiles = [
  { id: 'a', name: 'DE', protocol: 'socks5' as const, host: '1.2.3.4', port: 1080, username: 'u', password: 's3cret' },
  { id: 'b', name: 'US', protocol: 'http' as const, host: '5.6.7.8', port: 8080 },
];

describe('transfer', () => {
  it('rejects explicit unsupported protocols instead of silently using HTTP', () => {
    const result = parseImportJson(JSON.stringify([
      { name: 'bad', host: 'example.com', port: 8080, protocol: 'socks6' },
      { name: 'default', host: 'example.com', port: 8080 },
    ]));
    expect(result.invalid).toHaveLength(1);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].profile.protocol).toBe('http');
  });
  it('excludes passwords by default, includes on opt-in', () => {
    const plain = JSON.parse(buildExportJson(profiles, ['a'], { includeCredentials: false }));
    expect(plain[0].password).toBeUndefined();
    expect(plain[0].username).toBe('u');
    expect(plain[0].favorite).toBe(true);
    expect(plain[1].favorite).toBeUndefined();
    const cred = JSON.parse(buildExportJson(profiles, [], { includeCredentials: true }));
    expect(cred[0].password).toBe('s3cret');
  });

  it('validates JSON import without touching storage', () => {
    const r = parseImportJson(
      JSON.stringify([
        { name: 'OK', protocol: 'http', host: '1.2.3.4', port: 8080, favorite: true },
        { name: 'bad', host: '', port: 0 },
      ]),
    );
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].favorite).toBe(true);
    expect(r.valid[0].profile.id).toBeTruthy();
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]).toMatchObject({ index: 1 });
  });

  it('rejects non-JSON and non-arrays with a reason', () => {
    expect(parseImportJson('nope').invalid[0].reason).toMatch(/JSON/);
    expect(parseImportJson('{"a":1}').invalid[0].reason).toMatch(/array/);
  });

  it('quick-add prefills from a pasted string', () => {
    const r = parseQuickAdd('socks5://user:password@185.20.10.12:1080');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft).toMatchObject({
        protocol: 'socks5',
        host: '185.20.10.12',
        port: '1080',
        username: 'user',
        password: 'password',
      });
    }
    expect(parseQuickAdd('185.20.10.12:1080').ok).toBe(true);
    expect(parseQuickAdd('garbage').ok).toBe(false);
    expect(parseQuickAdd('a\nb').ok).toBe(false);
  });
});
