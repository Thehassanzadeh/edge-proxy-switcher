import { describe, expect, it } from 'vitest';
import {
  buildPacScript,
  findMatchingRule,
  matchSitePattern,
  pacTokenFor,
  validateSitePattern,
} from './siteRules';
import type { ProxyProfile, SiteRule } from '../types';

const de: ProxyProfile = { id: 'de', name: 'Germany', protocol: 'socks5', host: '1.2.3.4', port: 1080 };
const us: ProxyProfile = { id: 'us', name: 'US', protocol: 'http', host: '5.6.7.8', port: 8080, username: 'u', password: 'p' };
const https: ProxyProfile = { id: 'h', name: 'S', protocol: 'https', host: '9.9.9.9', port: 443 };
const s4: ProxyProfile = { id: 's4', name: 'S4', protocol: 'socks4', host: '7.7.7.7', port: 1080 };

function rule(over: Partial<SiteRule> = {}): SiteRule {
  return { id: 'r', pattern: 'example.com', targetProfileId: 'de', enabled: true, ...over };
}

describe('validateSitePattern', () => {
  it('accepts exact domains, IPs and wildcards', () => {
    expect(validateSitePattern('chatgpt.com')).toBeNull();
    expect(validateSitePattern('*.youtube.com')).toBeNull();
    expect(validateSitePattern('1.2.3.4')).toBeNull();
    expect(validateSitePattern('localhost')).toBeNull();
    expect(validateSitePattern('  ChatGPT.COM  ')).toBeNull();
  });

  it('rejects schemes, ports, paths and bad wildcards', () => {
    expect(validateSitePattern('')).not.toBeNull();
    expect(validateSitePattern('https://example.com')).not.toBeNull();
    expect(validateSitePattern('example.com:8080')).not.toBeNull();
    expect(validateSitePattern('example.com/path')).not.toBeNull();
    expect(validateSitePattern('*example.com')).not.toBeNull();
    expect(validateSitePattern('*.1.2.3.4')).not.toBeNull();
    expect(validateSitePattern('foo.*.com')).not.toBeNull();
  });
});

describe('matchSitePattern', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(matchSitePattern('chatgpt.com', 'chatgpt.com')).toBe(true);
    expect(matchSitePattern('chatgpt.com', 'ChatGPT.COM')).toBe(true);
    expect(matchSitePattern('chatgpt.com', 'sub.chatgpt.com')).toBe(false);
  });

  it('matches subdomains for wildcards but not the apex', () => {
    expect(matchSitePattern('*.youtube.com', 'music.youtube.com')).toBe(true);
    expect(matchSitePattern('*.youtube.com', 'a.b.youtube.com')).toBe(true);
    expect(matchSitePattern('*.youtube.com', 'youtube.com')).toBe(false);
    expect(matchSitePattern('*.youtube.com', 'notyoutube.com')).toBe(false);
  });
});

describe('findMatchingRule', () => {
  it('first enabled match wins; disabled rules skipped', () => {
    const rules = [
      rule({ id: 'off', pattern: '*.example.com', enabled: false }),
      rule({ id: 'second', pattern: '*.example.com' }),
      rule({ id: 'third', pattern: 'a.example.com' }),
    ];
    expect(findMatchingRule(rules, 'a.example.com')?.id).toBe('second');
    expect(findMatchingRule(rules, 'other.com')).toBeNull();
  });
});

describe('pacTokenFor', () => {
  it('maps protocols to PAC tokens', () => {
    expect(pacTokenFor(de)).toBe('SOCKS5 1.2.3.4:1080');
    expect(pacTokenFor(us)).toBe('PROXY 5.6.7.8:8080');
    expect(pacTokenFor(https)).toBe('HTTPS 9.9.9.9:443');
    expect(pacTokenFor(s4)).toBe('SOCKS 7.7.7.7:1080');
  });
});

describe('buildPacScript', () => {
  it('emits bypasses, rules in order, and proxy default', () => {
    const script = buildPacScript(
      [
        rule({ pattern: '*.youtube.com', targetProfileId: 'us' }),
        rule({ pattern: 'chatgpt.com', targetProfileId: null }),
      ],
      [de, us],
      'de',
    );
    expect(script).toContain('FindProxyForURL');
    expect(script).toContain('127.0.0.1');
    expect(script.indexOf('*.youtube.com')).toBeLessThan(script.indexOf('chatgpt.com'));
    expect(script).toContain('shExpMatch(host, "*.youtube.com")');
    expect(script).toContain('host === "chatgpt.com"');
    expect(script).toContain('return "PROXY 5.6.7.8:8080"');
    expect(script).toContain('return "DIRECT"');
    expect(script).toContain('return "SOCKS5 1.2.3.4:1080"');
  });

  it('defaults to DIRECT for global Direct and resolves missing targets to default', () => {
    const script = buildPacScript(
      [rule({ pattern: 'x.com', targetProfileId: 'gone' })],
      [de],
      null,
    );
    // missing target -> default (DIRECT here)
    expect(script).toContain('if (host === "x.com") return "DIRECT";');
    expect(script.trimEnd().endsWith('return "DIRECT";\n}')).toBe(true);
  });

  it('skips disabled rules', () => {
    const script = buildPacScript([rule({ pattern: 'x.com', enabled: false })], [de], 'de');
    expect(script).not.toContain('x.com');
  });
});
