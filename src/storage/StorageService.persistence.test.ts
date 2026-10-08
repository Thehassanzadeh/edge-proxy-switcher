import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../types';

afterEach(() => vi.unstubAllGlobals());

async function setup(raw: Record<string, unknown>) {
  vi.resetModules();
  const local = {
    get: vi.fn().mockResolvedValue(raw),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('chrome', { storage: { local } });
  const { StorageService } = await import('./StorageService');
  return { local, service: StorageService };
}

describe('storage persistence failures', () => {
  it('preserves legacy keys when migration cannot be written', async () => {
    const { local, service } = await setup({ profiles: [], settings: { theme: 'dark' } });
    local.set.mockRejectedValue(new Error('write failed'));
    expect((await service.getState()).settings.theme).toBe('dark');
    expect(local.remove).not.toHaveBeenCalled();
  });

  it('does not cache an update that failed to persist', async () => {
    const { local, service } = await setup({ state: structuredClone(DEFAULT_STATE) });
    await service.getState();
    local.set.mockRejectedValue(new Error('write failed'));
    await expect(service.saveSettings({ theme: 'dark' })).rejects.toThrow('write failed');
    expect((await service.getState()).settings.theme).toBe('system');
  });

  it('does not overwrite stored data when reading fails', async () => {
    const { local, service } = await setup({});
    local.get.mockRejectedValue(new Error('read failed'));
    await expect(service.getState()).rejects.toThrow('read failed');
    expect(local.set).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
  });
});
