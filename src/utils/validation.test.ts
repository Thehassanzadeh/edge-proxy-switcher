import { describe, expect, it } from 'vitest';
import { maskHost, validateHost, validatePort, validateProfile } from './validation';

describe('validation', () => {
  it('rejects malformed IPv6 while accepting compressed and IPv4-mapped literals', () => {
    for (const host of ['[:::]', '[1:2]', '[12345::1]', '[1::2::3]', '[::ffff:999.1.1.1]']) {
      expect(validateHost(host)).not.toBeNull();
    }
    expect(validateHost('[2001:db8::1]')).toBeNull();
    expect(validateHost('[::ffff:192.0.2.1]')).toBeNull();
  });
  it('accepts IPv4, hostnames, localhost and bracketed IPv6', () => {
    expect(validateHost('185.1.2.3')).toBeNull();
    expect(validateHost('proxy.example.com')).toBeNull();
    expect(validateHost('localhost')).toBeNull();
    expect(validateHost('[::1]')).toBeNull();
  });

  it('rejects empty, scheme-like, and out-of-range hosts', () => {
    expect(validateHost('')).not.toBeNull();
    expect(validateHost('http://1.2.3.4')).not.toBeNull();
    expect(validateHost('1.2.3.4:8080')).not.toBeNull();
    expect(validateHost('999.1.1.1')).not.toBeNull();
    expect(validateHost('has space.com')).not.toBeNull();
  });

  it('accepts ports 1..65535 only', () => {
    expect(validatePort(1)).toBeNull();
    expect(validatePort(65535)).toBeNull();
    expect(validatePort(0)).not.toBeNull();
    expect(validatePort(65536)).not.toBeNull();
    expect(validatePort(1.5)).not.toBeNull();
    expect(validatePort(NaN)).not.toBeNull();
  });

  it('validateProfile flags name/host/port problems', () => {
    expect(validateProfile({ name: '', host: 'x', port: 80 })).toHaveProperty('name');
    expect(validateProfile({ name: 'a', host: '', port: 80 })).toHaveProperty('host');
    expect(validateProfile({ name: 'a', host: '1.2.3.4', port: 0 })).toHaveProperty('port');
    expect(validateProfile({ name: 'a', host: '1.2.3.4', port: 8080 })).toEqual({});
  });

  it('maskHost hides IPv4 octets', () => {
    expect(maskHost('185.20.10.12')).toBe('185.xxx.xxx.xxx');
  });
});
