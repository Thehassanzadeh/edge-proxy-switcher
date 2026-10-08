import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, type ExtensionState, type ProxyProfile } from '../types';
import {
  computeNextState,
  expectsOwnership,
  resolveTargetForHost,
  selectAuthCandidate,
  validateAcceptCurrentIp,
  validateAcceptTest,
} from './RoutingOps';

function stateWith(over: Partial<ExtensionState>): ExtensionState {
  return {
    ...DEFAULT_STATE,
    settings: { ...DEFAULT_STATE.settings },
    profiles: [],
    favoriteIds: [],
    recentIds: [],
    rules: [],
    rulesEnabled: false,
    tests: {},
    currentIp: null,
    ...over,
  };
}

const httpA: ProxyProfile = { id: 'a', name: 'A', protocol: 'http', host: '10.0.0.1', port: 8080, username: 'userA', password: 'pa' };
const httpB: ProxyProfile = { id: 'b', name: 'B', protocol: 'http', host: '10.0.0.1', port: 8080, username: 'userB', password: 'pb' };
const socks: ProxyProfile = { id: 's', name: 'S', protocol: 'socks5', host: '10.0.0.1', port: 8080, username: 'userS', password: 'ps' };

describe('resolveTargetForHost', () => {
  it('uses the global profile when no rules match', () => {
    const s = stateWith({ profiles: [httpA], activeProfileId: 'a' });
    expect(resolveTargetForHost(s, 'api.ipify.org')).toBe('a');
  });

  it('prefers the first enabled matching rule (Direct or profile)', () => {
    const s = stateWith({
      profiles: [httpA, httpB],
      activeProfileId: 'a',
      rulesEnabled: true,
      rules: [
        { id: 'r1', pattern: 'api.ipify.org', targetProfileId: null, enabled: true },
        { id: 'r2', pattern: 'api.ipify.org', targetProfileId: 'b', enabled: true },
      ],
    });
    expect(resolveTargetForHost(s, 'api.ipify.org')).toBeNull();
  });

  it('falls back to the default when a rule target was deleted', () => {
    const s = stateWith({
      profiles: [httpA],
      activeProfileId: 'a',
      rulesEnabled: true,
      rules: [{ id: 'r1', pattern: 'example.com', targetProfileId: 'gone', enabled: true }],
    });
    expect(resolveTargetForHost(s, 'example.com')).toBe('a');
  });

  it('always sends loopback direct', () => {
    const s = stateWith({ profiles: [httpA], activeProfileId: 'a', rulesEnabled: false, rules: [] });
    expect(resolveTargetForHost(s, 'localhost')).toBeNull();
    expect(resolveTargetForHost(s, '127.0.0.1')).toBeNull();
  });
});

describe('selectAuthCandidate', () => {
  it('prefers the active profile on same-endpoint ties', () => {
    const s = stateWith({ profiles: [httpA, httpB], activeProfileId: 'b' });
    expect(selectAuthCandidate(s, '10.0.0.1', 8080)?.id).toBe('b');
  });

  it('never returns SOCKS credentials', () => {
    const s = stateWith({ profiles: [socks], activeProfileId: 's' });
    expect(selectAuthCandidate(s, '10.0.0.1', 8080)).toBeNull();
  });

  it('never returns an inactive, unrouted same-endpoint profile', () => {
    const s = stateWith({ profiles: [httpA, httpB], activeProfileId: null });
    expect(selectAuthCandidate(s, '10.0.0.1', 8080)).toBeNull();
  });

  it('prefers the rule target for the requesting URL', () => {
    const s = stateWith({
      profiles: [httpA, httpB],
      activeProfileId: 'a',
      rulesEnabled: true,
      rules: [{ id: 'r1', pattern: 'example.com', targetProfileId: 'b', enabled: true }],
    });
    expect(selectAuthCandidate(s, '10.0.0.1', 8080, 'example.com')?.id).toBe('b');
    expect(selectAuthCandidate(s, '10.0.0.1', 8080, 'other.com')?.id).toBe('a');
  });

  it('returns null when a Direct rule handles the requesting URL', () => {
    const s = stateWith({
      profiles: [httpA],
      activeProfileId: 'a',
      rulesEnabled: true,
      rules: [{ id: 'r1', pattern: 'example.com', targetProfileId: null, enabled: true }],
    });
    expect(selectAuthCandidate(s, '10.0.0.1', 8080, 'example.com')).toBeNull();
  });
});

describe('computeNextState invalidation', () => {
  it('clears the profile test when that profile is edited', () => {
    const s = stateWith({
      profiles: [httpA],
      activeProfileId: 'a',
      tests: { a: { ok: true, at: 1 } },
      currentIp: { ok: true, at: 1 },
    });
    const next = computeNextState(s, { kind: 'upsert', profile: { ...httpA, port: 9090 } });
    expect(next.tests['a']).toBeUndefined();
    expect(next.currentIp).toBeNull();
  });

  it('drops the active profile and its test on delete', () => {
    const s = stateWith({
      profiles: [httpA],
      activeProfileId: 'a',
      tests: { a: { ok: true, at: 1 } },
      currentIp: { ok: true, at: 1 },
    });
    const next = computeNextState(s, { kind: 'delete', id: 'a' });
    expect(next.activeProfileId).toBeNull();
    expect(next.tests['a']).toBeUndefined();
    expect(next.currentIp).toBeNull();
  });

  it('clears tests/currentIp on rule changes and replace imports', () => {
    const s = stateWith({
      profiles: [httpA],
      activeProfileId: 'a',
      tests: { a: { ok: true, at: 1 } },
      currentIp: { ok: true, at: 1 },
    });
    const ruled = computeNextState(s, {
      kind: 'ruleAdd',
      rule: { id: 'r1', pattern: 'example.com', targetProfileId: 'a', enabled: true },
    });
    expect(ruled.tests).toEqual({});
    expect(ruled.currentIp).toBeNull();
    const replaced = computeNextState(s, { kind: 'replace', profiles: [], favoriteIds: [] });
    expect(replaced.tests).toEqual({});
    expect(replaced.currentIp).toBeNull();
    expect(replaced.activeProfileId).toBeNull();
  });

  it('moves rules by id without submitting whole-list snapshots from callers', () => {
    const s = stateWith({
      rules: [
        { id: 'r1', pattern: 'a.com', targetProfileId: null, enabled: true },
        { id: 'r2', pattern: 'b.com', targetProfileId: null, enabled: true },
      ],
    });
    const next = computeNextState(s, { kind: 'ruleMove', id: 'r2', dir: -1 });
    expect(next.rules.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('bumps routingRevision on routing ops but not on prefs/favorites', () => {
    const s = stateWith({ routingRevision: 7, profiles: [httpA], activeProfileId: 'a' });
    expect(computeNextState(s, { kind: 'activate', id: 'a' }).routingRevision).toBe(8);
    expect(
      computeNextState(s, { kind: 'upsert', profile: { ...httpA, port: 9090 } }).routingRevision,
    ).toBe(8);
    expect(
      computeNextState(s, { kind: 'ruleMove', id: 'x', dir: 1 }).routingRevision,
    ).toBe(8);
    expect(computeNextState(s, { kind: 'settings', patch: { theme: 'dark' } }).routingRevision).toBe(7);
    expect(computeNextState(s, { kind: 'favorite', id: 'a', favorite: true }).routingRevision).toBe(7);
    expect(
      computeNextState(s, { kind: 'saveTest', key: 'a', test: { ok: true, at: 1 } }).routingRevision,
    ).toBe(7);
  });

  it('stamps accepted results with their verified revision', () => {
    const s = stateWith({ routingRevision: 4, profiles: [httpA], activeProfileId: 'a' });
    const tested = computeNextState(s, {
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, at: 1 },
      revision: 4,
    });
    expect(tested.tests['a']).toMatchObject({ ok: true, rev: 4 });
    expect(tested.routingRevision).toBe(4);
    const current = computeNextState(s, {
      kind: 'acceptCurrentIp',
      test: { ok: true, at: 1 },
      revision: 4,
    });
    expect(current.currentIp).toMatchObject({ ok: true, rev: 4 });
  });
});

describe('acceptance validators', () => {
  it('accepts a test only for the current revision and resolved route', () => {
    const s = stateWith({ routingRevision: 5, profiles: [httpA], activeProfileId: 'a' });
    expect(validateAcceptTest(s, 'a', 5)).toBe('ok');
    expect(validateAcceptTest(s, 'a', 4)).toBe('stale-route');
    expect(validateAcceptTest(s, 'missing', 5)).toBe('stale-route');
  });

  it('rejects when rules move the check host away (change-away-and-back safe)', () => {
    const base = stateWith({ routingRevision: 9, profiles: [httpA, httpB], activeProfileId: 'a' });
    // A -> B -> A leaves the visible state identical but bumps twice.
    const moved = computeNextState(computeNextState(base, { kind: 'activate', id: 'b' }), {
      kind: 'activate',
      id: 'a',
    });
    expect(moved.activeProfileId).toBe('a');
    expect(validateAcceptTest(moved, 'a', 9)).toBe('stale-route');
    const ruled = stateWith({
      routingRevision: 9,
      profiles: [httpA],
      activeProfileId: 'a',
      rulesEnabled: true,
      rules: [{ id: 'r1', pattern: 'api.ipify.org', targetProfileId: null, enabled: true }],
    });
    expect(validateAcceptTest(ruled, 'a', 9)).toBe('stale-route');
    expect(validateAcceptCurrentIp(ruled, 9)).toBe('ok');
    expect(validateAcceptCurrentIp(ruled, 8)).toBe('stale-route');
  });

  it('expectsOwnership matches routing intent (any enabled rule counts)', () => {
    expect(expectsOwnership(stateWith({}))).toBe(false);
    expect(expectsOwnership(stateWith({ activeProfileId: 'a' }))).toBe(true);
    expect(
      expectsOwnership(
        stateWith({
          rulesEnabled: true,
          rules: [{ id: 'r1', pattern: 'a.com', targetProfileId: null, enabled: true }],
        }),
      ),
    ).toBe(true);
  });
});
