import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../types';

afterEach(() => vi.unstubAllGlobals());

function profile(over: Record<string, unknown>) {
  return { id: 'x', name: 'X', protocol: 'http', host: '10.0.0.1', port: 8080, ...over };
}

async function loadBackground(opts: {
  state?: Record<string, unknown>;
  control?: string;
}) {
  vi.resetModules();
  const stored = {
    state: {
      ...structuredClone(DEFAULT_STATE),
      profiles: [],
      activeProfileId: null,
      rules: [],
      rulesEnabled: false,
      ...opts.state,
    },
  };
  const get = vi.fn(async () => structuredClone(stored));
  let authHandler: (d: unknown, cb?: (r: unknown) => void) => unknown = () => {};
  const addListener = vi.fn((fn: typeof authHandler) => {
    authHandler = fn;
  });
  vi.stubGlobal('chrome', {
    storage: { local: { get, set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
    proxy: {
      settings: {
        get: vi.fn(async () => ({ levelOfControl: opts.control ?? 'controlled_by_this_extension' })),
        set: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      },
    },
    webRequest: {
      onAuthRequired: { hasListener: () => false, addListener },
      onCompleted: { addListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn() },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getURL: (p: string) => p,
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  });
  await import('./background');
  return { authHandler: () => authHandler, get };
}

function challenge(handler: (d: unknown, cb?: (r: unknown) => void) => unknown, details: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve) => {
    handler(details, (r) => resolve(r as Record<string, unknown>));
    // Handler answers asynchronously; give the microtask queue a turn.
    setTimeout(() => {}, 0);
  }).then(
    (immediate) =>
      new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => resolve(immediate), 20);
      }),
  );
}

describe('background proxy auth', () => {
  it('prefers the active profile on same-endpoint ties', async () => {
    const { authHandler } = await loadBackground({
      state: {
        profiles: [
          profile({ id: 'a', username: 'userA', password: 'pa' }),
          profile({ id: 'b', username: 'userB', password: 'pb' }),
        ],
        activeProfileId: 'b',
      },
    });
    const res = await challenge(authHandler(), {
      isProxy: true,
      requestId: 'r-prefer',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(res).toEqual({ authCredentials: { username: 'userB', password: 'pb' } });
  });

  it('never supplies SOCKS credentials', async () => {
    const { authHandler } = await loadBackground({
      state: {
        profiles: [profile({ id: 's', protocol: 'socks5', username: 'u', password: 'p' })],
        activeProfileId: 's',
      },
    });
    const res = await challenge(authHandler(), {
      isProxy: true,
      requestId: 'r-socks',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(res).toEqual({});
  });

  it('does not use an inactive unrouted same-endpoint account', async () => {
    const { authHandler } = await loadBackground({
      state: {
        profiles: [profile({ id: 'a', username: 'userA', password: 'pa' })],
        activeProfileId: null,
      },
    });
    const res = await challenge(authHandler(), {
      isProxy: true,
      requestId: 'r-inactive',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(res).toEqual({});
  });

  it('bounds retries per request (invalid password does not loop)', async () => {
    const { authHandler } = await loadBackground({
      state: {
        profiles: [profile({ id: 'a', username: 'u', password: 'p' })],
        activeProfileId: 'a',
      },
    });
    const h = authHandler();
    const first = await challenge(h, {
      isProxy: true,
      requestId: 'r-retry',
      url: 'https://example.com/',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(first).toEqual({ authCredentials: { username: 'u', password: 'p' } });
    const second = await challenge(h, {
      isProxy: true,
      requestId: 'r-retry',
      url: 'https://example.com/',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(second).toEqual({});
  });

  it('supplies nothing when another extension owns routing', async () => {
    const { authHandler } = await loadBackground({
      control: 'controlled_by_other_extensions',
      state: {
        profiles: [profile({ id: 'a', username: 'u', password: 'p' })],
        activeProfileId: 'a',
      },
    });
    const res = await challenge(authHandler(), {
      isProxy: true,
      requestId: 'r-owned',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(res).toEqual({});
  });

  it('routes rule targets by requesting URL on same-endpoint ties', async () => {
    const { authHandler } = await loadBackground({
      state: {
        profiles: [
          profile({ id: 'a', username: 'userA', password: 'pa' }),
          profile({ id: 'b', username: 'userB', password: 'pb' }),
        ],
        activeProfileId: 'a',
        rulesEnabled: true,
        rules: [{ id: 'r1', pattern: 'example.com', targetProfileId: 'b', enabled: true }],
      },
    });
    const h = authHandler();
    const forRule = await challenge(h, {
      isProxy: true,
      requestId: 'r-rule-1',
      url: 'https://example.com/page',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(forRule).toEqual({ authCredentials: { username: 'userB', password: 'pb' } });
    const forDefault = await challenge(h, {
      isProxy: true,
      requestId: 'r-rule-2',
      url: 'https://other.com/',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(forDefault).toEqual({ authCredentials: { username: 'userA', password: 'pa' } });
  });
});
