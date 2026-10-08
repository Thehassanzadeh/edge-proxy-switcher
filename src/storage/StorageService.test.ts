import { describe, expect, it } from 'vitest';
import { migrateState } from './StorageService';
import { SCHEMA_VERSION } from '../types';

const profile = {
  id: 'p1',
  name: 'DE',
  protocol: 'socks5',
  host: '1.2.3.4',
  port: 1080,
};

describe('migrateState', () => {
  it('migrates legacy split keys (v0) without dropping profiles', () => {
    const s = migrateState({
      profiles: [profile],
      settings: { activeProfileId: 'p1', theme: 'dark', showIp: false, confirmDelete: true },
    });
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.profiles).toHaveLength(1);
    expect(s.activeProfileId).toBe('p1');
    expect(s.settings.theme).toBe('dark');
    expect(s.favoriteIds).toEqual([]);
    expect(s.recentIds).toEqual([]);
  });

  it('starts empty from unknown input', () => {
    const s = migrateState(null);
    expect(s.profiles).toEqual([]);
    expect(s.activeProfileId).toBeNull();
  });

  it('drops dangling references but keeps valid ones', () => {
    const s = migrateState({
      state: {
        profiles: [profile],
        activeProfileId: 'missing',
        favoriteIds: ['p1', 'ghost'],
        recentIds: ['ghost', 'p1'],
      },
    });
    expect(s.activeProfileId).toBeNull();
    expect(s.favoriteIds).toEqual(['p1']);
    expect(s.recentIds).toEqual(['p1']);
  });

  it('filters out malformed profiles', () => {
    const s = migrateState({
      profiles: [profile, { id: 'bad', host: 'x' }, null, 'nope'],
    });
    expect(s.profiles).toHaveLength(1);
  });

  it('migrates v1 state to v3 with empty rules and zeroed revision', () => {
    const s = migrateState({
      state: {
        schemaVersion: 1,
        profiles: [profile],
        activeProfileId: null,
        favoriteIds: [],
        recentIds: [],
        tests: {},
        currentIp: null,
        settings: { theme: 'system', showIp: true, confirmDelete: true },
      },
    });
    expect(s.schemaVersion).toBe(3);
    expect(s.rules).toEqual([]);
    expect(s.rulesEnabled).toBe(false);
    expect(s.routingRevision).toBe(0);
    expect(s.profiles).toHaveLength(1);
  });

  it('preserves a valid routing revision and resets malformed ones', () => {
    expect(
      migrateState({ state: { profiles: [profile], routingRevision: 12 } }).routingRevision,
    ).toBe(12);
    expect(migrateState({ state: { profiles: [profile] } }).routingRevision).toBe(0);
    expect(
      migrateState({ state: { profiles: [profile], routingRevision: -3 } }).routingRevision,
    ).toBe(0);
  });

  it('keeps valid rules and drops malformed ones', () => {
    const s = migrateState({
      state: {
        profiles: [profile],
        rules: [
          { id: 'r1', pattern: '*.example.com', targetProfileId: null, enabled: true },
          { id: 'bad', pattern: 42 },
        ],
        rulesEnabled: true,
      },
    });
    expect(s.rules).toHaveLength(1);
    expect(s.rulesEnabled).toBe(true);
  });
});
