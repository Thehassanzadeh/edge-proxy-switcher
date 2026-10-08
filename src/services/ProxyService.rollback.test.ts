import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../types';

afterEach(() => vi.unstubAllGlobals());

interface Mem {
  store: Record<string, unknown>;
  setCalls: number;
  setImpl?: (v: Record<string, unknown>) => Promise<void>;
  control: string;
  rejectSet: boolean;
  rejectClear: boolean;
  cleared: boolean;
  setValues: unknown[];
}

function seedState(activeId: string | null) {
  return {
    state: {
      ...structuredClone(DEFAULT_STATE),
      activeProfileId: activeId,
      profiles: [
        { id: 'a', name: 'A', protocol: 'http', host: '10.0.0.1', port: 8080 },
        { id: 'b', name: 'B', protocol: 'http', host: '10.0.0.2', port: 8080 },
      ],
    },
  };
}

async function setup(mem: Partial<Mem> = {}, messaging: 'none' | 'reject' = 'none') {
  vi.resetModules();
  const m: Mem = {
    store: seedState('a') as Record<string, unknown>,
    setCalls: 0,
    control: 'controlled_by_this_extension',
    rejectSet: false,
    rejectClear: false,
    cleared: false,
    setValues: [],
    ...mem,
  };
  const local = {
    get: vi.fn(async () => structuredClone(m.store)),
    set: vi.fn(async (v: Record<string, unknown>) => {
      m.setCalls += 1;
      if (m.setImpl) return m.setImpl(v);
      m.store = { ...m.store, ...structuredClone(v) };
    }),
    remove: vi.fn(async () => {}),
  };
  const proxySettings = {
    get: vi.fn(async () => ({ levelOfControl: m.control })),
    set: vi.fn(async (v: unknown) => {
      m.setValues.push(v);
      if (m.rejectSet) throw new Error('rejected');
      m.control = 'controlled_by_this_extension';
    }),
    clear: vi.fn(async () => {
      if (m.rejectClear) throw new Error('rejected');
      m.cleared = true;
      m.control = 'controllable_by_this_extension';
    }),
  };
  const chromeDouble: Record<string, unknown> = {
    storage: { local, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    proxy: { settings: proxySettings },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    webRequest: { onAuthRequired: { hasListener: () => false, addListener: vi.fn() } },
  };
  if (messaging === 'reject') {
    chromeDouble.runtime = { sendMessage: vi.fn(async () => Promise.reject(new Error('port closed'))) };
  }
  vi.stubGlobal('chrome', chromeDouble);
  const { ProxyService, BackgroundUnreachableError } = await import('./ProxyService');
  const { StorageService } = await import('../storage/StorageService');
  return { ProxyService, BackgroundUnreachableError, StorageService, local, proxySettings, mem: m };
}

describe('ProxyService dev-fallback failure/rollback (no messaging)', () => {
  it('restores the previous profile when applying B is rejected (not null)', async () => {
    const { ProxyService, StorageService } = await setup({ rejectSet: true });
    const b = { id: 'b', name: 'B', protocol: 'http' as const, host: '10.0.0.2', port: 8080 };
    await expect(ProxyService.applyProfile(b)).rejects.toThrow();
    expect((await StorageService.getFreshState()).activeProfileId).toBe('a');
  });

  it('does not record Direct when clear() fails', async () => {
    const { ProxyService, StorageService } = await setup({ rejectClear: true });
    await expect(ProxyService.applyDirect()).rejects.toThrow();
    expect((await StorageService.getFreshState()).activeProfileId).toBe('a');
  });

  it('rolls back an active-profile edit when routing fails', async () => {
    const { ProxyService, StorageService } = await setup({ rejectSet: true });
    await expect(
      ProxyService.upsertProfile({ id: 'a', name: 'A', protocol: 'http', host: '9.9.9.9', port: 8080 }),
    ).rejects.toThrow();
    const fresh = await StorageService.getFreshState();
    expect(fresh.profiles.find((p) => p.id === 'a')?.host).toBe('10.0.0.1');
    expect(fresh.activeProfileId).toBe('a');
  });

  it('treats a post-apply ownership loss as failure and rolls back', async () => {
    const ctx = await setup({});
    // First get (pre-check) ours, second get (post-check) other-extension.
    let calls = 0;
    ctx.proxySettings.get.mockImplementation(async () => {
      calls += 1;
      return { levelOfControl: calls === 1 ? 'controlled_by_this_extension' : 'controlled_by_other_extensions' };
    });
    const b = { id: 'b', name: 'B', protocol: 'http' as const, host: '10.0.0.2', port: 8080 };
    await expect(ctx.ProxyService.applyProfile(b)).rejects.toThrow();
    expect((await ctx.StorageService.getFreshState()).activeProfileId).toBe('a');
  });

  it('serializes concurrent updates without losing changes', async () => {
    const { StorageService } = await setup({});
    await StorageService.getState();
    await Promise.all([
      StorageService.update((d) => {
        d.settings.theme = 'dark';
      }),
      StorageService.update((d) => {
        d.settings.showIp = false;
      }),
    ]);
    const fresh = await StorageService.getFreshState();
    expect(fresh.settings.theme).toBe('dark');
    expect(fresh.settings.showIp).toBe(false);
  });
});

describe('ProxyService transport failure (messaging present, background lost)', () => {
  it('reports the failure and performs no local write', async () => {
    const { ProxyService, BackgroundUnreachableError, local } = await setup({}, 'reject');
    await expect(ProxyService.patchSettings({ theme: 'dark' })).rejects.toBeInstanceOf(
      BackgroundUnreachableError,
    );
    expect(local.set).not.toHaveBeenCalled();
  });
});
