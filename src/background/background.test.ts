import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('completes non-proxy authentication callbacks without supplying credentials', async () => {
  vi.resetModules();
  const addListener = vi.fn();
  const get = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: { local: { get } },
    webRequest: { onAuthRequired: { hasListener: () => false, addListener } },
  });
  await import('./background');
  const handler = addListener.mock.calls[0][0];
  const callback = vi.fn();
  handler({ isProxy: false }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({});
  expect(get).not.toHaveBeenCalled();
});
