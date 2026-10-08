import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../types';
import type { MutationOp } from '../services/RoutingOps';

afterEach(() => vi.unstubAllGlobals());

interface Mem {
  store: Record<string, unknown>;
  control: string;
  rejectSet: boolean;
  rejectClear: boolean;
  getImpl?: () => Promise<Record<string, unknown>>;
  setImpl?: (v: Record<string, unknown>) => Promise<void>;
}

function seedState(over: Record<string, unknown> = {}) {
  return {
    state: {
      ...structuredClone(DEFAULT_STATE),
      profiles: [
        { id: 'a', name: 'A', protocol: 'http', host: '10.0.0.1', port: 8080, username: 'userA', password: 'pa' },
        { id: 'b', name: 'B', protocol: 'http', host: '10.0.0.2', port: 8080 },
      ],
      activeProfileId: 'a',
      ...over,
    },
  };
}

let opCounter = 0;

async function loadOwner(mem: Partial<Mem> = {}) {
  vi.resetModules();
  const m: Mem = {
    store: seedState() as Record<string, unknown>,
    control: 'controlled_by_this_extension',
    rejectSet: false,
    rejectClear: false,
    ...mem,
  };
  const local = {
    get: vi.fn(async () => {
      if (m.getImpl) return m.getImpl();
      return structuredClone(m.store);
    }),
    set: vi.fn(async (v: Record<string, unknown>) => {
      if (m.setImpl) return m.setImpl(v);
      m.store = { ...m.store, ...structuredClone(v) };
    }),
    remove: vi.fn(async () => {}),
  };
  const proxySettings = {
    get: vi.fn(async () => ({ levelOfControl: m.control })),
    set: vi.fn(async () => {
      if (m.rejectSet) throw new Error('rejected');
      m.control = 'controlled_by_this_extension';
    }),
    clear: vi.fn(async () => {
      if (m.rejectClear) throw new Error('rejected');
      m.control = 'controllable_by_this_extension';
    }),
  };
  type MessageHandler = (msg: Record<string, unknown>, sender: unknown, respond: (r: unknown) => void) => unknown;
  type AuthHandler = (d: unknown, cb?: (r: unknown) => void) => unknown;
  let messageHandler: MessageHandler = () => {
    throw new Error('background did not register onMessage');
  };
  let messageRegistered = false;
  let authHandler: AuthHandler = () => {
    throw new Error('background did not register onAuthRequired');
  };
  const completedFilters: unknown[] = [];
  const errorFilters: unknown[] = [];
  vi.stubGlobal('chrome', {
    storage: { local, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    proxy: { settings: proxySettings },
    webRequest: {
      onAuthRequired: {
        hasListener: () => false,
        addListener: vi.fn((fn: AuthHandler) => {
          authHandler = fn;
        }),
      },
      onCompleted: {
        addListener: vi.fn((_fn: unknown, filter: unknown) => {
          completedFilters.push(filter);
        }),
      },
      onErrorOccurred: {
        addListener: vi.fn((_fn: unknown, filter: unknown) => {
          errorFilters.push(filter);
        }),
      },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((fn: MessageHandler) => {
          messageHandler = fn;
          messageRegistered = true;
        }),
      },
      getURL: (p: string) => p,
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  });
  await import('./background');
  if (!messageRegistered) throw new Error('background did not register onMessage');
  const handler = messageHandler;
  const mutate = (op: MutationOp, opId = `op-${(opCounter += 1)}`) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      try {
        const r = handler({ type: 'onlyproxy:mutate', op, opId }, {}, (v) => resolve(v as Record<string, unknown>));
        if (r !== true) reject(new Error('listener did not return true (no response will arrive)'));
      } catch (e) {
        reject(e);
      }
    });
  const readState = () => structuredClone(m.store).state as Record<string, unknown>;
  return { mutate, readState, proxySettings, mem: m, authHandler: () => authHandler, completedFilters, errorFilters };
}

function challenge(handler: ((d: unknown, cb?: (r: unknown) => void) => unknown) | null, details: Record<string, unknown>) {
  if (!handler) throw new Error('no auth handler');
  return new Promise<Record<string, unknown>>((resolve) => {
    handler(details, (r) => resolve(r as Record<string, unknown>));
  }).then(
    (immediate) =>
      new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => resolve(immediate), 20);
      }),
  );
}

describe('background single owner (production boundary)', () => {
  it('rolls back storage when applying B is rejected', async () => {
    const { mutate, readState } = await loadOwner({ rejectSet: true });
    const res = await mutate({ kind: 'activate', id: 'b' });
    expect(res.ok).toBe(false);
    expect(readState().activeProfileId).toBe('a');
  });

  it('does not record Direct when clear() fails', async () => {
    const { mutate, readState } = await loadOwner({ rejectClear: true });
    const res = await mutate({ kind: 'activate', id: null });
    expect(res.ok).toBe(false);
    expect(readState().activeProfileId).toBe('a');
  });

  it('answers storage read failures instead of leaving the caller hanging', async () => {
    const { mutate } = await loadOwner({
      getImpl: async () => {
        throw new Error('read boom');
      },
    });
    const res = await mutate({ kind: 'settings', patch: { theme: 'dark' } });
    expect(res).toMatchObject({ ok: false, error: 'storage-failed', code: 'storage' });
  });

  it('answers initial storage write failures', async () => {
    const { mutate, readState } = await loadOwner({
      setImpl: async () => {
        throw new Error('write boom');
      },
    });
    const res = await mutate({ kind: 'activate', id: 'b' });
    expect(res).toMatchObject({ ok: false, error: 'storage-failed', code: 'storage' });
    expect(readState().activeProfileId).toBe('a');
  });

  it('answers storage-failed when the final commit fails after a successful apply', async () => {
    vi.resetModules();
    const store = seedState() as Record<string, unknown>;
    const local = {
      get: vi.fn(async () => structuredClone(store)),
      // The single atomic commit (state + replay record) fails even though
      // the browser apply succeeded: the caller must get a structured
      // failure, never a hang and never a false ok:true.
      set: vi.fn(async () => {
        throw new Error('commit boom');
      }),
      remove: vi.fn(async () => {}),
    };
    type CommitMessageHandler = (msg: Record<string, unknown>, sender: unknown, respond: (r: unknown) => void) => unknown;
    let messageHandler: CommitMessageHandler = () => {
      throw new Error('background did not register onMessage');
    };
    let messageRegistered = false;
    vi.stubGlobal('chrome', {
      storage: { local, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
      proxy: {
        settings: {
          get: vi.fn(async () => ({ levelOfControl: 'controlled_by_this_extension' })),
          set: vi.fn(async () => {}),
          clear: vi.fn(async () => {}),
        },
      },
      webRequest: {
        onAuthRequired: { hasListener: () => false, addListener: vi.fn() },
        onCompleted: { addListener: vi.fn() },
        onErrorOccurred: { addListener: vi.fn() },
      },
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: {
          addListener: vi.fn((fn: CommitMessageHandler) => {
            messageHandler = fn;
            messageRegistered = true;
          }),
        },
        getURL: (p: string) => p,
      },
      action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    });
    await import('./background');
    const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!messageRegistered) {
        reject(new Error('no response will arrive'));
        return;
      }
      const r = messageHandler({ type: 'onlyproxy:mutate', op: { kind: 'activate', id: 'b' }, opId: 'op-commit-fail' }, {}, (v) =>
        resolve(v as Record<string, unknown>),
      );
      if (r !== true) reject(new Error('no response will arrive'));
    });
    expect(res).toMatchObject({ ok: false, error: 'storage-failed', code: 'storage' });
  });

  it('executes duplicate opIds once (lost-response retry does not duplicate)', async () => {
    const { mutate, readState } = await loadOwner({});
    const x = { id: 'x', name: 'X', protocol: 'http' as const, host: '9.9.9.9', port: 8080 };
    const opId = 'op-lost-response';
    // First attempt "loses" its response; retry reuses the same opId.
    const first = await mutate({ kind: 'addMany', profiles: [x], favoriteIds: [] }, opId);
    expect(first.ok).toBe(true);
    const retry = await mutate({ kind: 'addMany', profiles: [x], favoriteIds: [] }, opId);
    expect(retry.ok).toBe(true);
    const ids = ((readState().profiles ?? []) as { id: string }[]).map((p) => p.id);
    expect(ids.filter((id) => id === 'x')).toHaveLength(1);
  });

  it('deduplicates simultaneous same-opId requests', async () => {
    const { mutate, readState } = await loadOwner({});
    const x = { id: 'y', name: 'Y', protocol: 'http' as const, host: '8.8.8.8', port: 8080 };
    const opId = 'op-simultaneous';
    const [r1, r2] = await Promise.all([
      mutate({ kind: 'addMany', profiles: [x], favoriteIds: [] }, opId),
      mutate({ kind: 'addMany', profiles: [x], favoriteIds: [] }, opId),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const ids = ((readState().profiles ?? []) as { id: string }[]).map((p) => p.id);
    expect(ids.filter((id) => id === 'y')).toHaveLength(1);
  });

  it('applies simultaneous distinct requests without losing either', async () => {
    const { mutate, readState } = await loadOwner({});
    const [r1, r2] = await Promise.all([
      mutate({ kind: 'ruleAdd', rule: { id: 'r1', pattern: 'a.com', targetProfileId: null, enabled: true } }),
      mutate({ kind: 'settings', patch: { theme: 'dark' } }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const s = readState();
    expect(((s.rules ?? []) as { id: string }[]).map((r) => r.id)).toContain('r1');
    expect((s.settings as { theme: string }).theme).toBe('dark');
  });
});

describe('background atomic test acceptance', () => {
  it('saves a verified result with its revision', async () => {
    const ctx = await loadOwner({});
    const rev = (ctx.readState().routingRevision ?? 0) as number;
    const res = await ctx.mutate({
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, ip: '1.2.3.4', at: 1 },
      revision: rev,
    });
    expect(res.ok).toBe(true);
    const tests = ctx.readState().tests as Record<string, { ok: boolean; rev: number }>;
    expect(tests['a']).toMatchObject({ ok: true, rev });
  });

  it('discards a result after an intervening edit (stale revision, no write)', async () => {
    const ctx = await loadOwner({});
    const rev = (ctx.readState().routingRevision ?? 0) as number;
    await ctx.mutate({ kind: 'ruleAdd', rule: { id: 'r9', pattern: 'x.com', targetProfileId: null, enabled: true } });
    const res = await ctx.mutate({
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, ip: '1.2.3.4', at: 1 },
      revision: rev,
    });
    expect(res).toMatchObject({ ok: false, code: 'stale-route' });
    expect(ctx.readState().tests).toEqual({});
  });

  it('discards after change-away-and-back (A -> B -> A)', async () => {
    const ctx = await loadOwner({});
    const rev = (ctx.readState().routingRevision ?? 0) as number;
    await ctx.mutate({ kind: 'activate', id: 'b' });
    await ctx.mutate({ kind: 'activate', id: 'a' });
    const res = await ctx.mutate({
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, ip: '1.2.3.4', at: 1 },
      revision: rev,
    });
    expect(res).toMatchObject({ ok: false, code: 'stale-route' });
    expect(ctx.readState().tests).toEqual({});
  });

  it('discards when ownership lapsed, without writing', async () => {
    const ctx = await loadOwner({});
    const rev = (ctx.readState().routingRevision ?? 0) as number;
    ctx.mem.control = 'controlled_by_other_extensions';
    const res = await ctx.mutate({
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, ip: '1.2.3.4', at: 1 },
      revision: rev,
    });
    expect(res).toMatchObject({ ok: false, code: 'not-owned' });
    expect(ctx.readState().tests).toEqual({});
  });

  it('discards when site rules no longer resolve the check host to the profile', async () => {
    const ctx = await loadOwner({
      store: seedState({
        rulesEnabled: true,
        rules: [{ id: 'r1', pattern: 'api.ipify.org', targetProfileId: null, enabled: true }],
      }) as Record<string, unknown>,
    });
    const rev = (ctx.readState().routingRevision ?? 0) as number;
    const res = await ctx.mutate({
      kind: 'acceptTest',
      key: 'a',
      test: { ok: true, ip: '1.2.3.4', at: 1 },
      revision: rev,
    });
    expect(res).toMatchObject({ ok: false, code: 'stale-route' });
    expect(ctx.readState().tests).toEqual({});
  });
});

describe('background auth (production boundary)', () => {
  it('serves the default proxy after its rule target was deleted', async () => {
    const profile = { id: 'a', name: 'A', protocol: 'http', host: '10.0.0.1', port: 8080, username: 'userA', password: 'pa' };
    const ctx = await loadOwner({
      store: seedState({
        profiles: [profile],
        activeProfileId: 'a',
        rulesEnabled: true,
        rules: [{ id: 'r', pattern: 'example.com', targetProfileId: 'deleted', enabled: true }],
      }) as Record<string, unknown>,
    });
    const res = await challenge(ctx.authHandler(), {
      isProxy: true,
      requestId: 'r-deleted-target',
      url: 'https://example.com/',
      challenger: { host: '10.0.0.1', port: 8080 },
    });
    expect(res).toEqual({ authCredentials: { username: 'userA', password: 'pa' } });
  });

  it('registers request cleanup with the required URL filter', async () => {
    const ctx = await loadOwner({});
    expect(ctx.completedFilters).toContainEqual({ urls: ['<all_urls>'] });
    expect(ctx.errorFilters).toContainEqual({ urls: ['<all_urls>'] });
  });
});

describe('background worker lifecycle', () => {
  it('deduplicates a resent opId after a worker restart (persisted replay record)', async () => {
    const first = await loadOwner({});
    const op: MutationOp = {
      kind: 'addMany',
      profiles: [{ id: 'new', name: 'N', protocol: 'http', host: 'example.com', port: 80 }],
      favoriteIds: [],
    };
    const r1 = await first.mutate(op, 'lost-response');
    expect(r1.ok).toBe(true);
    // Fresh worker, same persisted storage: in-memory dedup is gone, but the
    // replay record committed atomically with the mutation is not.
    const restarted = await loadOwner({ store: structuredClone(first.mem.store) });
    const r2 = await restarted.mutate(op, 'lost-response');
    expect(r2.ok).toBe(true);
    const ids = ((restarted.readState().profiles ?? []) as { id: string }[]).map((p) => p.id);
    expect(ids.filter((id) => id === 'new')).toHaveLength(1);
  });

  it('does not hand a live request a fresh auth budget after sixty seconds', async () => {
    vi.useFakeTimers();
    try {
      const owner = await loadOwner({});
      const h = owner.authHandler();
      if (!h) throw new Error('no auth handler');
      const details = {
        isProxy: true,
        requestId: 'live',
        url: 'https://example.com/',
        challenger: { host: '10.0.0.1', port: 8080 },
      };
      const ask = () =>
        new Promise<Record<string, unknown>>((resolve) => {
          (h as (d: unknown, cb?: (r: unknown) => void) => unknown)(details, (r: unknown) =>
            resolve(r as Record<string, unknown>),
          );
        });
      expect(await ask()).toHaveProperty('authCredentials');
      await vi.advanceTimersByTimeAsync(60001);
      expect(await ask()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('rollback carries a fresh revision and drops cached results', async () => {
    const owner = await loadOwner({
      store: seedState({
        tests: { a: { ok: true, ip: '1.2.3.4', at: 1, rev: 0 } },
        routingRevision: 0,
      }) as Record<string, unknown>,
    });
    const revision = owner.readState().routingRevision as number;
    // The new route installs fine, then the post-apply ownership query fails.
    owner.proxySettings.get
      .mockResolvedValueOnce({ levelOfControl: 'controlled_by_this_extension' })
      .mockRejectedValueOnce(new Error('post-apply failed'));
    expect((await owner.mutate({ kind: 'activate', id: 'b' })).ok).toBe(false);
    expect(owner.proxySettings.set).toHaveBeenCalledTimes(2);
    const after = owner.readState();
    expect(after.activeProfileId).toBe('a');
    expect(after.routingRevision as number).toBeGreaterThan(revision);
    expect(after.tests).toEqual({});
    // A test begun before the transient routing now reports stale, even
    // though the visible active profile is A again.
    const result = await owner.mutate({
      kind: 'acceptTest',
      key: 'a',
      revision,
      test: { ok: true, at: 1, ip: '192.0.2.1' },
    });
    expect(result).toMatchObject({ ok: false, code: 'stale-route' });
  });
});
