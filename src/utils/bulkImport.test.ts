import { describe, expect, it } from 'vitest';
import { parseBulkImport, toProfiles } from './bulkImport';

describe('parseBulkImport', () => {
  it('parses host:port with the default protocol', () => {
    const [item] = parseBulkImport('185.1.2.3:1080', 'socks5');
    expect(item.valid).toBe(true);
    expect(item.draft).toMatchObject({ protocol: 'socks5', host: '185.1.2.3', port: 1080 });
  });

  it('parses host:port:user:pass', () => {
    const [item] = parseBulkImport('45.4.5.6:8080:user:pass', 'http');
    expect(item.valid).toBe(true);
    expect(item.draft).toMatchObject({ host: '45.4.5.6', port: 8080, username: 'user', password: 'pass' });
  });

  it('parses user:pass@host:port', () => {
    const [item] = parseBulkImport('u:pw@7.8.9.0:1080', 'socks5');
    expect(item.valid).toBe(true);
    expect(item.draft).toMatchObject({ host: '7.8.9.0', username: 'u', password: 'pw' });
  });

  it('parses scheme URLs and overrides the default protocol', () => {
    const items = parseBulkImport('http://11.22.33.44:8080\nsocks5://u:p@55.66.77.88:1080', 'socks5');
    expect(items[0].draft).toMatchObject({ protocol: 'http', host: '11.22.33.44' });
    expect(items[1].draft).toMatchObject({ protocol: 'socks5', username: 'u', password: 'p' });
  });

  it('marks unknown schemes, garbage, bad ports and comments correctly', () => {
    const items = parseBulkImport('ftp://1.2.3.4:21\nbad-line\n1.2.3.4:99999\n# comment\n\n9.9.9.9:1', 'http');
    expect(items).toHaveLength(4); // comment + blank skipped
    expect(items[0].valid).toBe(false);
    expect(items[1].valid).toBe(false);
    expect(items[2].valid).toBe(false);
    expect(items[2].message).toMatch(/Port/);
    expect(items[3].valid).toBe(true);
  });

  it('toProfiles assigns unique ids and keeps auth', () => {
    const items = parseBulkImport('1.1.1.1:80\nu:p@2.2.2.2:8080', 'http');
    const profiles = toProfiles(items);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).not.toBe(profiles[1].id);
    expect(profiles[1]).toMatchObject({ username: 'u', password: 'p' });
  });
});
