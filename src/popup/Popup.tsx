import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Copy,
  RefreshCw,
  Search,
  Settings,
  Star,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { ProxyForm, draftFromProfile } from '../components/ProxyForm';
import { friendlyTestError, IpService } from '../services/IpService';
import { BackgroundUnreachableError, friendlyControlError, ProxyControlError, ProxyService, RouteStaleError, type ControlState } from '../services/ProxyService';
import { resolveTargetForHost } from '../services/RoutingOps';
import { StorageService } from '../storage/StorageService';
import { newProfileId, timeAgo, type ExtensionState, type ProxyProfile, type StoredTest } from '../types';
import { maskHost } from '../utils/validation';

function openOptions() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
    void chrome.runtime.openOptionsPage();
  } else {
    window.open('options.html', '_blank');
  }
}

export default function Popup() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [control, setControl] = useState<ControlState>('unavailable');
  const [externalChange, setExternalChange] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyProfile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProxyProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const s = await StorageService.getState();
    setState(s);
    setControl(await ProxyService.getControlState());
    setExternalChange(await ProxyService.detectExternalChange());
  }, []);

  useEffect(() => {
    void reload();
    return StorageService.onChanged(() => void reload());
  }, [reload]);

  // Close overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const profiles = state?.profiles ?? [];
  const activeId = state?.activeProfileId ?? null;
  const showIp = state?.settings.showIp ?? true;
  const confirmDelete = state?.settings.confirmDelete ?? true;
  const favoriteIds = useMemo(() => new Set(state?.favoriteIds ?? []), [state]);
  const tests = state?.tests ?? {};
  const currentIp = state?.currentIp ?? null;

  const active = useMemo(() => profiles.find((p) => p.id === activeId) ?? null, [profiles, activeId]);
  const activeTest = active ? tests[active.id] : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (p) => p.name.toLowerCase().includes(q) || p.host.toLowerCase().includes(q),
    );
  }, [profiles, query]);

  const showSearch = profiles.length > 4;
  const favorites = useMemo(
    () => filtered.filter((p) => favoriteIds.has(p.id)),
    [filtered, favoriteIds],
  );
  const nonFavorites = useMemo(
    () => filtered.filter((p) => !favoriteIds.has(p.id)),
    [filtered, favoriteIds],
  );
  const showRecent = profiles.length > 5 && !query.trim();
  const recent = useMemo(() => {
    if (!showRecent || !state) return [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return state.recentIds
      .map((id) => byId.get(id))
      .filter((p): p is ProxyProfile => !!p && p.id !== activeId && !favoriteIds.has(p.id))
      .slice(0, 4);
  }, [showRecent, state, profiles, activeId, favoriteIds]);
  const recentIds = useMemo(() => new Set(recent.map((p) => p.id)), [recent]);
  const rest = useMemo(() => nonFavorites.filter((p) => !recentIds.has(p.id)), [nonFavorites, recentIds]);

  const activate = async (id: string | null) => {
    if (testingId !== null) {
      setError('Wait for the current connection test to finish before switching.');
      return;
    }
    setBusyId(id ?? 'direct');
    setError(null);
    setShowRecovery(false);
    try {
      if (id === null) {
        await ProxyService.applyDirect();
      } else {
        const fresh = await StorageService.getFreshState().catch(() => null);
        const p = (fresh?.profiles ?? profiles).find((x) => x.id === id);
        if (!p) {
          setError('That profile no longer exists.');
          return;
        }
        await ProxyService.applyProfile(p);
      }
    } catch (e) {
      if (e instanceof ProxyControlError) {
        setError(friendlyControlError(e.kind));
      } else if (e instanceof BackgroundUnreachableError) {
        setError(e.message);
      } else {
        setError('Failed to switch proxy.');
        setShowRecovery(true);
      }
    } finally {
      setBusyId(null);
      void reload();
    }
  };

  const checkCurrent = useCallback(async () => {
    setChecking(true);
    try {
      const before = await StorageService.getFreshState().catch(() => null);
      const revision = before?.routingRevision ?? 0;
      const r = await IpService.testCurrentConnection();
      // Accepted atomically by the background owner: an intervening routing
      // change or lapsed ownership discards the result instead of recording it.
      try {
        await ProxyService.acceptCurrentIp(r, revision);
      } catch (e) {
        if (e instanceof RouteStaleError || e instanceof BackgroundUnreachableError) {
          setError(e.message);
        } else {
          setError('Failed to check the current connection.');
        }
      }
    } finally {
      setChecking(false);
      const s = await StorageService.getState();
      setState(s);
    }
  }, []);

  /** Testing a profile activates it first (extension fetches obey the active proxy). */
  const testProfile = async (p: ProxyProfile) => {
    if (testingId !== null || busyId !== null) {
      setError('Wait for the current operation to finish before testing.');
      return;
    }
    setTestingId(p.id);
    setError(null);
    setShowRecovery(false);
    try {
      // Hold the tested route: no switching while the check runs (activate()
      // above refuses while testingId is set).
      const pre = await StorageService.getFreshState().catch(() => null);
      const preControl = await ProxyService.getControlState();
      if (preControl === 'other-extension' || preControl === 'policy') {
        throw new ProxyControlError(preControl);
      }
      const baseState = pre ?? state;
      if (!baseState) throw new Error('no state');
      const hypothetical = { ...baseState, activeProfileId: p.id };
      // api.ipify.org is the only host this check ever contacts. If site rules
      // would send it elsewhere, a success would verify the wrong route.
      if (resolveTargetForHost(hypothetical, 'api.ipify.org') !== p.id) {
        setError(
          'Site rules route the connection check elsewhere, so this profile cannot be verified while they are on. Adjust or disable the rule for api.ipify.org and try again.',
        );
        return;
      }
      const liveProfile = baseState.profiles.find((x) => x.id === p.id);
      if (!liveProfile) {
        setError('That profile no longer exists.');
        return;
      }
      if (baseState.activeProfileId !== p.id) {
        await ProxyService.applyProfile(liveProfile);
      } else {
        // Even the already-active profile must actually own the browser route;
        // otherwise the check would verify someone else's proxy.
        const recheck = await ProxyService.getControlState();
        if (recheck === 'other-extension' || recheck === 'policy') {
          throw new ProxyControlError(recheck);
        }
        if (recheck !== 'ours' && recheck !== 'unavailable') {
          throw new ProxyControlError('rejected');
        }
      }
      const beforeFetch = await StorageService.getFreshState().catch(() => null);
      const revision = beforeFetch?.routingRevision ?? 0;
      const snapshot = {
        host: liveProfile.host,
        port: liveProfile.port,
        protocol: liveProfile.protocol,
        username: liveProfile.username ?? '',
        password: liveProfile.password ?? '',
        rulesEnabled: beforeFetch?.rulesEnabled ?? baseState.rulesEnabled,
        rules: JSON.stringify(beforeFetch?.rules ?? baseState.rules),
      };
      const r = await IpService.testCurrentConnection();
      // The result is recorded only through atomic background acceptance:
      // same revision, same tested route, still ours. Anything else is
      // discarded without writing, so a stale success can never be attached
      // to this profile — including change-away-and-back (A -> B -> A), which
      // bumps the revision twice.
      const postProfile = (await StorageService.getFreshState().catch(() => null))?.profiles.find(
        (x) => x.id === p.id,
      );
      if (
        !postProfile ||
        postProfile.host !== snapshot.host ||
        postProfile.port !== snapshot.port ||
        postProfile.protocol !== snapshot.protocol ||
        (postProfile.username ?? '') !== snapshot.username ||
        (postProfile.password ?? '') !== snapshot.password
      ) {
        setError('Settings changed during the test — result discarded.');
        return;
      }
      try {
        await ProxyService.acceptTest(p.id, r, revision);
      } catch (e) {
        if (e instanceof RouteStaleError || e instanceof BackgroundUnreachableError) {
          setError(e.message);
          return;
        }
        throw e;
      }
      if (r.ok) {
        // Best-effort: the current-connection cache follows a verified test.
        // A rejection here only means something changed in between; the
        // profile result above is already recorded.
        await ProxyService.acceptCurrentIp(r, revision).catch(() => {});
      }
    } catch (e) {
      if (e instanceof ProxyControlError) {
        setError(friendlyControlError(e.kind));
      } else if (e instanceof RouteStaleError || e instanceof BackgroundUnreachableError) {
        setError(e.message);
      } else {
        await IpService.saveTest(p.id, {
          ok: false,
          at: Date.now(),
          cause: 'unreachable',
          detail: 'Activation or test failed.',
        }).catch(() => {});
        setError('Failed to test this proxy.');
        setShowRecovery(true);
      }
    } finally {
      setTestingId(null);
      void reload();
    }
  };

  const saveProfile = async (value: Omit<ProxyProfile, 'id'>) => {
    setError(null);
    try {
      if (editing) {
        await ProxyService.upsertProfile({ ...value, id: editing.id });
      } else {
        await ProxyService.addProfiles([{ ...value, id: newProfileId() }]);
      }
    } catch (e) {
      if (e instanceof ProxyControlError) {
        setError(friendlyControlError(e.kind));
        return;
      }
      if (e instanceof BackgroundUnreachableError) {
        setError(e.message);
        return;
      }
      setError('Failed to save this proxy.');
      return;
    }
    setFormOpen(false);
    setEditing(null);
  };

  const doDelete = async (p: ProxyProfile) => {
    setError(null);
    try {
      await ProxyService.deleteProfile(p.id);
    } catch (e) {
      if (e instanceof ProxyControlError) {
        setError(friendlyControlError(e.kind));
      } else if (e instanceof BackgroundUnreachableError) {
        setError(e.message);
      } else {
        setError('Failed to delete this proxy.');
      }
      return;
    }
    setPendingDelete(null);
  };

  const toggleFavorite = async (p: ProxyProfile) => {
    const fav = !(state?.favoriteIds.includes(p.id) ?? false);
    try {
      await ProxyService.setFavorite(p.id, fav);
    } catch (e) {
      setError(e instanceof BackgroundUnreachableError ? e.message : 'Failed to update favorites.');
    }
    setMenuFor(null);
  };

  const duplicate = async (p: ProxyProfile) => {
    try {
      await ProxyService.addProfiles([{ ...p, id: newProfileId(), name: `${p.name} (copy)` }]);
    } catch (e) {
      setError(e instanceof BackgroundUnreachableError ? e.message : 'Failed to duplicate this proxy.');
    }
    setMenuFor(null);
  };

  const displayHost = (h: string) => (showIp ? h : maskHost(h));
  const conflicted = control === 'other-extension' || control === 'policy';
  const rulesOn = !!state?.rulesEnabled && (state?.rules.some((r) => r.enabled) ?? false);
  const activeRuleCount = state?.rules.filter((r) => r.enabled).length ?? 0;
  const proxyTargets = state?.rules.some((r) => r.enabled && r.targetProfileId !== null) ?? false;
  const routing = !!active || (rulesOn && proxyTargets);

  if (!state) {
    // Local state loads synchronously-fast; this is only a first-paint guard.
    return <div className="w-[380px] p-4 text-sm text-neutral-400">Loading…</div>;
  }

  return (
    <div className="w-[380px] bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />
          <span className="text-sm font-semibold">OnlyProxy</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              routing && !conflicted
                ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${routing && !conflicted ? 'bg-green-500' : 'bg-neutral-400'}`}
              aria-hidden
            />
            {conflicted ? 'Blocked' : active ? 'Proxy Active' : rulesOn ? 'Rules Active' : 'Direct'}
          </span>
          <button
            onClick={openOptions}
            title="Settings"
            aria-label="Open settings"
            className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Conflict / external-change notices */}
      {conflicted && (
        <div className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            {control === 'other-extension'
              ? 'Proxy settings are controlled by another extension. Disable it to let OnlyProxy take control.'
              : 'Proxy settings are controlled by browser policy and cannot be changed by this extension.'}
          </p>
        </div>
      )}
      {!conflicted && externalChange && active && (
        <div className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            Proxy settings were changed outside this extension. Click “{active.name}” again to
            re-apply it, or choose Direct Connection (browser default).
          </p>
        </div>
      )}

      {/* Current connection */}
      <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Current connection</p>
          <button
            onClick={() => void checkCurrent()}
            title="Check current connection (manual)"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {checking ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
        {active ? (
          <div className="mt-1">
            <div className="flex items-center gap-1.5">
              <Wifi size={14} className="text-green-600 dark:text-green-400" aria-hidden />
              <span className="text-sm font-semibold">{active.name}</span>
              <span className="rounded bg-neutral-100 px-1.5 py-px font-mono text-[10px] uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {active.protocol}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-xs text-neutral-500 dark:text-neutral-400">
              {displayHost(active.host)}:{active.port}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              Configuration: Active · Connection:{' '}
              {activeTest ? (
                activeTest.ok ? (
                  <span className="text-green-600 dark:text-green-400">
                    Verified{activeTest.latencyMs != null ? ` · ${activeTest.latencyMs} ms` : ''} · {timeAgo(activeTest.at)}
                  </span>
                ) : (
                  <span className="text-red-500">Last test failed · {timeAgo(activeTest.at)}</span>
                )
              ) : (
                'Not tested'
              )}
            </p>
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-1.5">
            <WifiOff size={14} className="text-neutral-400" aria-hidden />
            <span className="text-sm font-medium">Direct Connection</span>
            <span className="text-xs text-neutral-400">— browser default</span>
          </div>
        )}
        {currentIp && (
          <p className={`mt-1 text-xs ${currentIp.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
            {currentIp.ok ? (
              <>
                IP{showIp && currentIp.ip ? `: ${currentIp.ip}` : ' detected'}
                {currentIp.latencyMs != null ? ` · ${currentIp.latencyMs} ms` : ''} · {timeAgo(currentIp.at)}
              </>
            ) : (
              <>{friendlyTestError(currentIp.cause, currentIp.detail)} <RetryLink onRetry={() => void checkCurrent()} /></>
            )}
          </p>
        )}
        {rulesOn && (
          <p className="mt-1 text-[11px] text-neutral-400">
            Site rules on ({activeRuleCount} active, PAC routing) ·{' '}
            <button onClick={openOptions} className="underline underline-offset-2 hover:opacity-80">
              Manage
            </button>
          </p>
        )}
      </div>
      {/* Error with recovery */}
      {error && (
        <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800" role="alert">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          {showRecovery && (
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={() => void activate(null)}
                className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 dark:bg-white dark:text-neutral-900"
              >
                Return to Direct Connection
              </button>
            </div>
          )}
        </div>
      )}

      {/* Search */}
      {showSearch && (
        <div className="px-2.5 pt-2">
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
            <Search size={13} className="shrink-0 text-neutral-400" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or host…"
              aria-label="Search proxies by name or host"
              className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
            />
          </div>
        </div>
      )}

      {/* Proxy list */}
      <div className="slim-scroll max-h-[280px] overflow-y-auto p-1.5" role="listbox" aria-label="Proxy profiles">
        <DirectRow
          selected={activeId === null}
          busy={busyId === 'direct'}
          onClick={() => void activate(null)}
        />
        {favorites.length > 0 && (
          <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Favorites
          </p>
        )}
        {favorites.map((p) => (
          <ProfileRow
            key={p.id}
            p={p}
            selected={p.id === activeId}
            busy={busyId === p.id}
            testing={testingId === p.id}
            isFavorite
            showIp={showIp}
            test={tests[p.id]}
            menuOpen={menuFor === p.id}
            onSelect={() => void activate(p.id)}
            onTest={() => void testProfile(p)}
            onToggleFavorite={() => void toggleFavorite(p)}
            onOpenMenu={() => setMenuFor(menuFor === p.id ? null : p.id)}
            onEdit={() => {
              setMenuFor(null);
              setEditing(p);
              setFormOpen(true);
            }}
            onDuplicate={() => void duplicate(p)}
            onAskDelete={() => {
              setMenuFor(null);
              if (confirmDelete || p.id === activeId) setPendingDelete(p);
              else void doDelete(p);
            }}
            menuRef={menuRef}
          />
        ))}
        {showRecent && recent.length > 0 && (
          <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Recently used
          </p>
        )}
        {showRecent &&
          recent.map((p) => (
            <ProfileRow
              key={p.id}
              p={p}
              selected={false}
              busy={busyId === p.id}
              testing={testingId === p.id}
              isFavorite={false}
              showIp={showIp}
              test={tests[p.id]}
              menuOpen={menuFor === p.id}
              onSelect={() => void activate(p.id)}
              onTest={() => void testProfile(p)}
              onToggleFavorite={() => void toggleFavorite(p)}
              onOpenMenu={() => setMenuFor(menuFor === p.id ? null : p.id)}
              onEdit={() => {
                setMenuFor(null);
                setEditing(p);
                setFormOpen(true);
              }}
              onDuplicate={() => void duplicate(p)}
              onAskDelete={() => {
                setMenuFor(null);
                if (confirmDelete || p.id === activeId) setPendingDelete(p);
                else void doDelete(p);
              }}
              menuRef={menuRef}
            />
          ))}
        {(favorites.length > 0 || (showRecent && recent.length > 0)) && rest.length > 0 && (
          <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            All proxies
          </p>
        )}
        {rest.map((p) => (
          <ProfileRow
            key={p.id}
            p={p}
            selected={p.id === activeId}
            busy={busyId === p.id}
            testing={testingId === p.id}
            isFavorite={favoriteIds.has(p.id)}
            showIp={showIp}
            test={tests[p.id]}
            menuOpen={menuFor === p.id}
            onSelect={() => void activate(p.id)}
            onTest={() => void testProfile(p)}
            onToggleFavorite={() => void toggleFavorite(p)}
            onOpenMenu={() => setMenuFor(menuFor === p.id ? null : p.id)}
            onEdit={() => {
              setMenuFor(null);
              setEditing(p);
              setFormOpen(true);
            }}
            onDuplicate={() => void duplicate(p)}
            onAskDelete={() => {
              setMenuFor(null);
              if (confirmDelete || p.id === activeId) setPendingDelete(p);
              else void doDelete(p);
            }}
            menuRef={menuRef}
          />
        ))}
        {profiles.length === 0 && (
          <div className="px-2 py-4 text-center">
            <p className="text-sm font-medium">No proxies yet</p>
            <p className="mt-0.5 text-xs text-neutral-400">Add a proxy to start switching connections.</p>
            <button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
              className="mt-2 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus size={14} aria-hidden /> Add Proxy
            </button>
          </div>
        )}
        {profiles.length > 0 && filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-neutral-400">
            No proxies match “{query.trim()}”.
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="flex gap-2 border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500"
        >
          <Plus size={14} aria-hidden /> Add Proxy
        </button>
      </div>

      {/* Add / Edit modal */}
      {formOpen && (
        <Modal title={editing ? 'Edit proxy' : 'Add proxy'} onClose={() => { setFormOpen(false); setEditing(null); }}>
          <ProxyForm
            initial={draftFromProfile(editing ?? undefined)}
            submitLabel={editing ? 'Save' : 'Add proxy'}
            onCancel={() => {
              setFormOpen(false);
              setEditing(null);
            }}
            onSubmit={(v) => void saveProfile(v)}
          />
        </Modal>
      )}

      {/* Delete confirm (active proxy warns about Direct fallback) */}
      {pendingDelete && (
        <Modal title="Delete proxy?" onClose={() => setPendingDelete(null)}>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            Delete <span className="font-semibold">{pendingDelete.name}</span>?
            {pendingDelete.id === activeId && (
              <span className="mt-1 block rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                This proxy is currently active. Deleting it will return the browser to
                Direct Connection (browser default).
              </span>
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setPendingDelete(null)}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              onClick={() => void doDelete(pendingDelete)}
              className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-red-500"
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RetryLink({ onRetry }: { onRetry: () => void }) {
  return (
    <button onClick={onRetry} className="ml-1 underline underline-offset-2 hover:opacity-80">
      Retry
    </button>
  );
}

function DirectRow({ selected, busy, onClick }: { selected: boolean; busy: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={`cursor-pointer rounded-lg border px-2.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
        selected
          ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/30'
          : 'border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${selected ? 'bg-blue-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} aria-hidden />
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">Direct Connection</span>
            {selected && !busy && <Check size={13} className="text-blue-600 dark:text-blue-400" aria-label="Selected" />}
            {busy && <Loader2 size={13} className="animate-spin text-blue-600" aria-hidden />}
          </div>
          <p className="text-[11px] text-neutral-400">Browser default · no extension proxy</p>
        </div>
        <WifiOff size={14} className="text-neutral-400" aria-hidden />
      </div>
    </div>
  );
}

function ProfileRow(props: {
  p: ProxyProfile;
  selected: boolean;
  busy: boolean;
  testing: boolean;
  isFavorite: boolean;
  showIp: boolean;
  test?: StoredTest;
  menuOpen: boolean;
  onSelect: () => void;
  onTest: () => void;
  onToggleFavorite: () => void;
  onOpenMenu: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onAskDelete: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { p, selected, busy, testing, isFavorite, showIp, test, menuOpen } = props;
  const host = showIp ? p.host : maskHost(p.host);
  return (
    <div
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
      role="option"
      aria-selected={selected}
      aria-label={`Connect ${p.name}, ${p.protocol}, ${p.host} port ${p.port}`}
      tabIndex={0}
      title={selected ? `${p.name} (active) — click to re-apply` : `Connect ${p.name}`}
      className={`group relative cursor-pointer rounded-lg border px-2.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
        selected
          ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/30'
          : 'border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-blue-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{p.name}</span>
            {selected && !busy && <Check size={13} className="shrink-0 text-blue-600 dark:text-blue-400" aria-label="Active" />}
            {busy && <Loader2 size={13} className="shrink-0 animate-spin text-blue-600" aria-hidden />}
          </div>
          <p className="font-mono text-[11px] uppercase text-neutral-400">
            {p.protocol} · <span className="normal-case">{host}:{p.port}</span>
            {p.username ? ' · auth' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
          <button
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={isFavorite ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
            aria-pressed={isFavorite}
            onClick={props.onToggleFavorite}
            className={`rounded-md p-1.5 focus-visible:outline-2 focus-visible:outline-blue-500 ${
              isFavorite
                ? 'text-amber-500 opacity-100'
                : 'text-neutral-400 opacity-0 hover:text-amber-500 focus:opacity-100 group-hover:opacity-100'
            }`}
          >
            <Star size={13} fill={isFavorite ? 'currentColor' : 'none'} aria-hidden />
          </button>
          <button
            title="Test (activates, then checks)"
            aria-label={`Test ${p.name}`}
            onClick={props.onTest}
            disabled={testing}
            className="rounded-md p-1.5 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-500 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            {testing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Zap size={13} aria-hidden />}
          </button>
          <button
            title="More actions"
            aria-label={`More actions for ${p.name}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={props.onOpenMenu}
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <MoreHorizontal size={14} aria-hidden />
          </button>
        </div>
      </div>
      {test && !testing && (
        <p className={`mt-1 pl-4 text-[11px] ${test.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
          {test.ok ? (
            <>Verified{test.latencyMs != null ? ` · ${test.latencyMs} ms` : ''} · {timeAgo(test.at)}</>
          ) : (
            <>{friendlyTestError(test.cause, test.detail)} · {timeAgo(test.at)}</>
          )}
        </p>
      )}
      {menuOpen && (
        <div
          ref={props.menuRef}
          role="menu"
          aria-label={`Actions for ${p.name}`}
          className="absolute right-1 top-9 z-20 w-36 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          <MenuItem icon={<Zap size={13} aria-hidden />} label="Test" onClick={() => { props.onTest(); }} />
          <MenuItem icon={<Pencil size={13} aria-hidden />} label="Edit" onClick={props.onEdit} />
          <MenuItem icon={<Copy size={13} aria-hidden />} label="Duplicate" onClick={props.onDuplicate} />
          <MenuItem
            icon={<Star size={13} aria-hidden />}
            label={isFavorite ? 'Unfavorite' : 'Favorite'}
            onClick={props.onToggleFavorite}
          />
          <MenuItem icon={<Trash2 size={13} aria-hidden />} label="Delete" danger onClick={props.onAskDelete} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 ${
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/40 p-3" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full rounded-xl bg-white p-3 shadow-xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
