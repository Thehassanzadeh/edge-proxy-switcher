import { useMemo, useState } from 'react';
import { PROTOCOLS, type ProxyProfile, type ProxyProtocol } from '../types';
import { parseQuickAdd } from '../utils/transfer';
import { validateProfile } from '../utils/validation';

export interface ProfileDraft {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
}

export function draftFromProfile(p?: ProxyProfile): ProfileDraft {
  return {
    name: p?.name ?? '',
    protocol: p?.protocol ?? 'http',
    host: p?.host ?? '',
    port: p ? String(p.port) : '',
    username: p?.username ?? '',
    password: p?.password ?? '',
  };
}

const inputCls =
  'w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none ' +
  'focus:border-blue-500 focus:ring-1 focus:ring-blue-500 ' +
  'dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100';

export function ProxyForm({
  initial,
  submitLabel,
  authNote,
  onSubmit,
  onCancel,
}: {
  initial: ProfileDraft;
  submitLabel: string;
  authNote?: string;
  onSubmit: (value: Omit<ProxyProfile, 'id'>) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [touched, setTouched] = useState(false);
  const [quick, setQuick] = useState('');
  const [quickError, setQuickError] = useState<string | null>(null);
  const set = (k: keyof ProfileDraft, v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const applyQuickAdd = () => {
    const r = parseQuickAdd(quick);
    if (!r.ok) {
      setQuickError(r.reason);
      return;
    }
    setQuickError(null);
    setDraft((d) => ({ ...d, ...r.draft }));
    setQuick('');
  };

  const errors = useMemo(
    () =>
      validateProfile({
        name: draft.name,
        host: draft.host,
        port: Number(draft.port),
      }),
    [draft.name, draft.host, draft.port],
  );
  const portRawInvalid = draft.port.trim() !== '' && !/^\d+$/.test(draft.port.trim());
  const hasError = Object.keys(errors).length > 0 || portRawInvalid;

  const showSocksAuthWarning =
    (draft.protocol === 'socks4' || draft.protocol === 'socks5') &&
    draft.username.trim() !== '';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (hasError) return;
        onSubmit({
          name: draft.name.trim(),
          protocol: draft.protocol,
          host: draft.host.trim(),
          port: Number(draft.port),
          ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
          ...(draft.username.trim() ? { password: draft.password } : {}),
        });
      }}
      className="space-y-2.5"
    >
      <div>
        <label htmlFor="proxy-quickadd" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Quick add — paste a proxy string to pre-fill
        </label>
        <div className="flex gap-1.5">
          <input
            id="proxy-quickadd"
            className={`${inputCls} font-mono text-xs`}
            placeholder="socks5://user:pass@185.20.10.12:1080"
            value={quick}
            onChange={(e) => {
              setQuick(e.target.value);
              setQuickError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyQuickAdd();
              }
            }}
          />
          <button
            type="button"
            onClick={applyQuickAdd}
            className="shrink-0 rounded-md border border-neutral-300 px-2.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Fill
          </button>
        </div>
        {quickError && <p className="mt-1 text-xs text-red-500">{quickError}</p>}
      </div>
      <div>
        <label htmlFor="proxy-name" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Name</label>
        <input
          id="proxy-name"
          className={inputCls}
          placeholder="e.g. Germany Proxy"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
        {touched && errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="proxy-protocol" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Protocol</label>
          <select
            id="proxy-protocol"
            className={inputCls}
            value={draft.protocol}
            onChange={(e) => {
              const proto = e.target.value as ProxyProtocol;
              const def = PROTOCOLS.find((p) => p.value === proto)?.defaultPort;
              setDraft((d) => ({
                ...d,
                protocol: proto,
                port: d.port.trim() === '' && def ? String(def) : d.port,
              }));
            }}
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="proxy-port" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Port</label>
          <input
            id="proxy-port"
            className={inputCls}
            inputMode="numeric"
            placeholder="8080"
            value={draft.port}
            onChange={(e) => set('port', e.target.value)}
          />
          {touched && (errors.port || portRawInvalid) && (
            <p className="mt-1 text-xs text-red-500">{errors.port ?? 'Port must be an integer.'}</p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="proxy-host" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Host / IP</label>
        <input
          id="proxy-host"
          className={inputCls}
          placeholder="185.xxx.xxx.xxx"
          value={draft.host}
          onChange={(e) => set('host', e.target.value)}
        />
        {touched && errors.host && <p className="mt-1 text-xs text-red-500">{errors.host}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="proxy-user" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Username <span className="font-normal">(optional)</span>
          </label>
          <input
            id="proxy-user"
            className={inputCls}
            autoComplete="off"
            value={draft.username}
            onChange={(e) => set('username', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="proxy-pass" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Password <span className="font-normal">(optional)</span>
          </label>
          <input
            id="proxy-pass"
            className={inputCls}
            type="password"
            autoComplete="new-password"
            value={draft.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </div>
      </div>

      {(authNote ?? showSocksAuthWarning) && (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          {showSocksAuthWarning
            ? 'Chromium does not support SOCKS username/password auth — these credentials will be stored but ignored by the browser. Use HTTP/HTTPS for authenticated proxies.'
            : authNote}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={touched && hasError}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
