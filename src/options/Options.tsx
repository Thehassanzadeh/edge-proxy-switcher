import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Download,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { ProxyForm, draftFromProfile } from '../components/ProxyForm';
import SiteRulesSection from './SiteRulesSection';
import { BackgroundUnreachableError, ProxyService } from '../services/ProxyService';
import { StorageService } from '../storage/StorageService';
import { useTheme } from '../hooks/useTheme';
import {
  newProfileId,
  PROTOCOLS,
  type ExtensionState,
  type ProxyProfile,
  type ProxyProtocol,
  type ThemePref,
} from '../types';
import { parseBulkImport, toProfiles } from '../utils/bulkImport';
import { buildExportJson, parseImportJson } from '../utils/transfer';

export default function Options() {
  const { theme, saveTheme } = useTheme();
  const [state, setState] = useState<ExtensionState | null>(null);
  const [editing, setEditing] = useState<ProxyProfile | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProxyProfile | null>(null);

  // Import / export
  const [exportPw, setExportPw] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'add' | 'replace'>('add');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [ioMsg, setIoMsg] = useState<string | null>(null);

  // Bulk import
  const [bulkText, setBulkText] = useState('');
  const [bulkProto, setBulkProto] = useState<ProxyProtocol>('socks5');
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = async () => setState(await StorageService.getState());

  useEffect(() => {
    void reload();
    return StorageService.onChanged(() => void reload());
  }, []);

  const profiles = state?.profiles ?? [];
  const activeId = state?.activeProfileId ?? null;
  const showIp = state?.settings.showIp ?? true;
  const confirmDelete = state?.settings.confirmDelete ?? true;
  const favoriteIds = useMemo(() => new Set(state?.favoriteIds ?? []), [state]);

  const bulkPreview = useMemo(
    () => parseBulkImport(bulkText, bulkProto),
    [bulkText, bulkProto],
  );
  const bulkValid = bulkPreview.filter((i) => i.valid).length;
  const bulkInvalid = bulkPreview.filter((i) => !i.valid).length;

  const jsonPreview = useMemo(
    () => (importText.trim() ? parseImportJson(importText) : null),
    [importText],
  );

  const saveProfile = async (value: Omit<ProxyProfile, 'id'>) => {
    setFormError(null);
    try {
      if (editing) {
        await ProxyService.upsertProfile({ ...value, id: editing.id });
      } else {
        await ProxyService.addProfiles([{ ...value, id: newProfileId() }]);
      }
    } catch (e) {
      setFormError(
        e instanceof Error && e.message
          ? e.message
          : 'Failed to save. The browser routing was left unchanged.',
      );
      return;
    }
    setEditing(null);
    setAdding(false);
  };

  const doDelete = async (p: ProxyProfile) => {
    setFormError(null);
    try {
      await ProxyService.deleteProfile(p.id);
    } catch (e) {
      setFormError(
        e instanceof BackgroundUnreachableError
          ? e.message
          : 'Delete failed. The browser routing was left unchanged.',
      );
      return;
    }
    setPendingDelete(null);
  };

  const askDelete = (p: ProxyProfile) => {
    // Always confirm when deleting the active proxy (Direct fallback warning).
    if (confirmDelete || p.id === activeId) setPendingDelete(p);
    else void doDelete(p);
  };

  const enableProfile = async (p: ProxyProfile) => {
    setFormError(null);
    try {
      await ProxyService.applyProfile(p);
    } catch (e) {
      setFormError(
        e instanceof BackgroundUnreachableError
          ? e.message
          : 'Activation failed. The previous routing was kept.',
      );
    }
  };

  // ---- JSON import / export ----
  const exportJson = () => {
    const blob = new Blob(
      [buildExportJson(profiles, state?.favoriteIds ?? [], { includeCredentials: exportPw })],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'proxy-profiles.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyJsonImport = async () => {
    setIoMsg(null);
    if (!jsonPreview || (jsonPreview.valid.length === 0 && jsonPreview.invalid.length > 0 && jsonPreview.invalid[0].index === -1)) {
      setIoMsg(jsonPreview?.invalid[0]?.reason ?? 'Nothing to import.');
      return;
    }
    const drafts = jsonPreview.valid;
    if (drafts.length === 0) {
      setIoMsg('No valid profiles found.');
      return;
    }
    if (importMode === 'replace' && !confirmReplace) {
      setIoMsg('Tick the confirmation to replace all existing profiles.');
      return;
    }
    const incoming = drafts.map((d) => d.profile);
    const favIds = drafts.filter((d) => d.favorite).map((d) => d.profile.id);
    try {
      if (importMode === 'replace') {
        await ProxyService.replaceAll(incoming, favIds);
      } else {
        await ProxyService.addProfiles(incoming, favIds);
      }
    } catch (e) {
      setIoMsg(
        e instanceof BackgroundUnreachableError
          ? e.message
          : 'Import failed. The browser routing was left unchanged.',
      );
      return;
    }
    setImportText('');
    setConfirmReplace(false);
    setIoMsg(
      `Imported ${drafts.length} profile(s)${jsonPreview.invalid.length > 0 ? `, skipped ${jsonPreview.invalid.length} invalid row(s).` : '.'}`,
    );
  };

  const importBulk = async () => {
    const valid = bulkPreview.filter((i) => i.valid);
    if (valid.length === 0) {
      setBulkMsg('Nothing valid to import.');
      return;
    }
    try {
      await ProxyService.addProfiles(toProfiles(valid));
    } catch (e) {
      setBulkMsg(
        e instanceof BackgroundUnreachableError
          ? e.message
          : 'Import failed. The browser routing was left unchanged.',
      );
      return;
    }
    setBulkText('');
    setBulkMsg(`Imported ${valid.length} profile(s).`);
  };

  const setPref = async (patch: { showIp?: boolean; confirmDelete?: boolean }) => {
    try {
      await ProxyService.patchSettings(patch);
    } catch (e) {
      setFormError(
        e instanceof BackgroundUnreachableError
          ? e.message
          : 'Saving preferences failed. Please retry.',
      );
      return;
    }
    const s = await StorageService.getState();
    setState(s);
  };

  const saveThemePref = async (t: ThemePref) => {
    try {
      await saveTheme(t);
    } catch (e) {
      setFormError(
        e instanceof BackgroundUnreachableError ? e.message : 'Saving theme failed. Please retry.',
      );
    }
  };

  if (!state) {
    return <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-neutral-400">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center gap-2">
        <SettingsIcon size={18} className="text-blue-600 dark:text-blue-400" aria-hidden />
        <h1 className="text-lg font-semibold">OnlyProxy — Settings</h1>
      </header>
      {formError && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
          {formError}
        </p>
      )}

      {/* Profiles */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="profiles-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="profiles-h" className="text-sm font-semibold">Proxy Profiles</h2>
          <button
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <Plus size={13} aria-hidden /> Add proxy
          </button>
        </div>

        {(adding || editing) && (
          <div className="mb-3 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800/60">
            <ProxyForm
              key={editing?.id ?? 'new'}
              initial={draftFromProfile(editing ?? undefined)}
              submitLabel={editing ? 'Save' : 'Add proxy'}
              onCancel={() => {
                setAdding(false);
                setEditing(null);
              }}
              onSubmit={(v) => void saveProfile(v)}
            />
          </div>
        )}

        {profiles.length === 0 ? (
          <p className="py-2 text-center text-sm text-neutral-400">No proxies saved.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <button
                  onClick={() =>
                    void ProxyService.setFavorite(p.id, !favoriteIds.has(p.id)).catch(() =>
                      setFormError('Failed to update favorites.'),
                    )
                  }
                  title={favoriteIds.has(p.id) ? 'Remove from favorites' : 'Add to favorites'}
                  aria-label={favoriteIds.has(p.id) ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
                  aria-pressed={favoriteIds.has(p.id)}
                  className={favoriteIds.has(p.id) ? 'text-amber-500' : 'text-neutral-300 hover:text-amber-500 dark:text-neutral-600'}
                >
                  <Star size={14} fill={favoriteIds.has(p.id) ? 'currentColor' : 'none'} aria-hidden />
                </button>
                <span className={`h-2 w-2 shrink-0 rounded-full ${p.id === activeId ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {p.name}
                    {p.id === activeId && (
                      <span className="ml-2 rounded bg-green-100 px-1.5 py-px text-[10px] font-semibold text-green-700 dark:bg-green-950 dark:text-green-300">
                        ACTIVE
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-[11px] uppercase text-neutral-400">
                    {p.protocol} · <span className="normal-case">{showIp ? p.host : '••••'}:{p.port}</span>
                    {p.username ? ' · auth' : ''}
                  </p>
                </div>
                {p.id !== activeId && (
                  <button
                    onClick={() => void enableProfile(p)}
                    title="Enable this proxy"
                    className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    <Check size={12} aria-hidden /> Enable
                  </button>
                )}
                <button
                  onClick={() => {
                    setAdding(false);
                    setEditing(p);
                  }}
                  title="Edit"
                  aria-label={`Edit ${p.name}`}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-800"
                >
                  <Pencil size={13} aria-hidden />
                </button>
                <button
                  onClick={() => {
                    setEditing(null);
                    void ProxyService.addProfiles([
                      { ...p, id: newProfileId(), name: `${p.name} (copy)` },
                    ]).catch(() => setFormError('Duplicate failed. Routing left unchanged.'));
                  }}
                  title="Duplicate"
                  aria-label={`Duplicate ${p.name}`}
                  className="rounded-md px-1.5 py-1 text-[11px] font-medium text-neutral-400 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-800"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => askDelete(p)}
                  title="Delete"
                  aria-label={`Delete ${p.name}`}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-red-500 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        {pendingDelete && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40" role="alert">
            <p>
              Delete <span className="font-semibold">{pendingDelete.name}</span>?
              {pendingDelete.id === activeId && (
                <span className="mt-1 block text-xs">
                  This proxy is currently active. Deleting it will return the browser to
                  Direct Connection (browser default).
                </span>
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700"
              >
                Cancel
              </button>
              <button
                onClick={() => void doDelete(pendingDelete)}
                className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </section>

      <SiteRulesSection
        profiles={profiles}
        rules={state.rules}
        rulesEnabled={state.rulesEnabled}
      />

      {/* General */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="general-h">
        <h2 id="general-h" className="mb-3 text-sm font-semibold">General</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="theme">Theme</label>
            <select
              id="theme"
              value={theme}
              onChange={(e) => void saveThemePref(e.target.value as ThemePref)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <Toggle
            label="Show IP addresses"
            desc="When off, hosts are masked (185.xxx.xxx.xxx)."
            checked={showIp}
            onChange={(v) => void setPref({ showIp: v })}
          />
          <Toggle
            label="Confirm before deleting"
            desc="Show a confirmation step in popup and settings."
            checked={confirmDelete}
            onChange={(v) => void setPref({ confirmDelete: v })}
          />
        </div>
      </section>

      {/* Import / Export */}
      <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="io-h">
        <h2 id="io-h" className="mb-3 text-sm font-semibold">Import / Export</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={exportJson}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            <Download size={13} aria-hidden /> Export JSON
          </button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={exportPw}
              onChange={(e) => setExportPw(e.target.checked)}
            />
            Include credentials
          </label>
        </div>
        <p className="mt-1.5 text-[11px] text-neutral-400">
          {exportPw
            ? 'Warning: exported credentials will be readable as plain text in the JSON file. Store it safely.'
            : 'Passwords are excluded from export by default.'}
        </p>

        <h3 className="mb-1 mt-4 text-xs font-semibold">Import JSON</h3>
        <div className="mb-2 flex gap-3 text-xs" role="radiogroup" aria-label="Import mode">
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="import-mode"
              checked={importMode === 'add'}
              onChange={() => setImportMode('add')}
            />
            Add to existing profiles
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="import-mode"
              checked={importMode === 'replace'}
              onChange={() => setImportMode('replace')}
            />
            Replace existing profiles
          </label>
        </div>
        <label htmlFor="json-import" className="sr-only">Paste exported JSON</label>
        <textarea
          id="json-import"
          value={importText}
          onChange={(e) => {
            setImportText(e.target.value);
            setIoMsg(null);
            setConfirmReplace(false);
          }}
          placeholder='Paste exported JSON here, e.g. [{"name":"…","protocol":"http","host":"…","port":8080}]'
          rows={4}
          className="w-full rounded-md border border-neutral-300 bg-white p-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800"
        />
        {jsonPreview && jsonPreview.valid.length + jsonPreview.invalid.length > 0 && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-neutral-200 text-xs dark:border-neutral-800">
            <p className="border-b border-neutral-200 px-2 py-1.5 font-medium dark:border-neutral-800">
              Preview — {jsonPreview.valid.length} valid
              {jsonPreview.invalid.length > 0 ? `, ${jsonPreview.invalid.length} invalid` : ''}
            </p>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {jsonPreview.valid.map((d) => (
                <li key={d.profile.id} className="px-2 py-1.5 text-green-600 dark:text-green-400">
                  ✓ {d.profile.protocol.toUpperCase()} {d.profile.host}:{d.profile.port}
                  {d.favorite ? ' ★' : ''}
                </li>
              ))}
              {jsonPreview.invalid.map((inv, i) => (
                <li key={`inv-${i}`} className="px-2 py-1.5 text-red-500">
                  ✗ Row {inv.index >= 0 ? inv.index + 1 : '?'} — {inv.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {importMode === 'replace' && (
          <label className="mt-2 flex cursor-pointer items-start gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={confirmReplace}
              onChange={(e) => setConfirmReplace(e.target.checked)}
              className="mt-0.5"
            />
            I understand this will delete all {profiles.length} existing profile(s) and replace
            them with the import.
          </label>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void applyJsonImport()}
            disabled={!jsonPreview || jsonPreview.valid.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Upload size={13} aria-hidden /> Import JSON
          </button>
          {ioMsg && <span className="text-xs text-neutral-500">{ioMsg}</span>}
        </div>
      </section>

      {/* Bulk import */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="bulk-h">
        <h2 id="bulk-h" className="mb-1 text-sm font-semibold">Bulk import from text</h2>
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">
          One proxy per line. Formats: <code>IP:PORT</code>,{' '}
          <code>IP:PORT:USER:PASS</code>, <code>USER:PASS@IP:PORT</code>,{' '}
          <code>http://IP:PORT</code>, <code>socks5://USER:PASS@IP:PORT</code>
        </p>
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor="bulkProto" className="text-xs text-neutral-500">
            Default protocol (lines without a scheme):
          </label>
          <select
            id="bulkProto"
            value={bulkProto}
            onChange={(e) => setBulkProto(e.target.value as ProxyProtocol)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor="bulk-text" className="sr-only">Paste proxies, one per line</label>
        <textarea
          id="bulk-text"
          value={bulkText}
          onChange={(e) => {
            setBulkText(e.target.value);
            setBulkMsg(null);
          }}
          placeholder={'185.1.2.3:1080\n45.4.5.6:8080:user:pass\nsocks5://user:pass@7.8.9.0:1080'}
          rows={6}
          className="w-full rounded-md border border-neutral-300 bg-white p-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800"
        />
        {bulkText.trim() && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-neutral-200 text-xs dark:border-neutral-800">
            <p className="border-b border-neutral-200 px-2 py-1.5 font-medium dark:border-neutral-800">
              Preview — {bulkValid} valid, {bulkInvalid} invalid
            </p>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {bulkPreview.map((i) => (
                <li key={i.key} className="px-2 py-1.5">
                  {i.valid && i.draft ? (
                    <span className="text-green-600 dark:text-green-400">
                      ✓ {i.draft.protocol.toUpperCase()} {i.draft.host}:{i.draft.port}
                      {i.draft.username ? ` (${i.draft.username})` : ''}
                    </span>
                  ) : (
                    <span className="text-red-500">
                      ✗ <span className="font-mono">{i.raw}</span> — {i.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void importBulk()}
            disabled={bulkValid === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Upload size={13} aria-hidden /> Import {bulkValid > 0 ? `${bulkValid} valid` : ''}
          </button>
          {bulkMsg && <span className="text-xs text-neutral-500">{bulkMsg}</span>}
        </div>
      </section>

      <footer className="pb-4 text-center text-[11px] text-neutral-400">
        Profiles and credentials are stored locally only. SOCKS credentials are stored but ignored by Chromium — see README.
      </footer>
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p>{label}</p>
        <p className="text-[11px] text-neutral-400">{desc}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${checked ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-700'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}
