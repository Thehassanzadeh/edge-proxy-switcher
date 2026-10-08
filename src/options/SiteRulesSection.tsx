import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { friendlyControlError, BackgroundUnreachableError, ProxyControlError, ProxyService } from '../services/ProxyService';
import { newProfileId, type ProxyProfile, type SiteRule } from '../types';
import {
  normalizeSitePattern,
  ruleTargetLabel,
  validateSitePattern,
} from '../utils/siteRules';

/**
 * Site-specific routing rules (PAC-based). Array order = priority, index 0 wins.
 * localhost / 127.0.0.1 / ::1 are always direct (built into the PAC script).
 */
export default function SiteRulesSection({
  profiles,
  rules,
  rulesEnabled,
}: {
  profiles: ProxyProfile[];
  rules: SiteRule[];
  rulesEnabled: boolean;
}) {
  const [pattern, setPattern] = useState('');
  const [target, setTarget] = useState<string>('direct');
  const [formError, setFormError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const runOp = async (fn: () => Promise<void>) => {
    setApplyError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof BackgroundUnreachableError) {
        setApplyError(e.message);
      } else if (e instanceof ProxyControlError) {
        setApplyError(`${friendlyControlError(e.kind)} The stored rules were rolled back.`);
      } else {
        setApplyError('Applying site rules failed. The stored rules were rolled back.');
      }
    }
  };

  const addRule = () => {
    const err = validateSitePattern(pattern);
    if (err) {
      setFormError(err);
      return;
    }
    const normalized = normalizeSitePattern(pattern);
    if (rules.some((r) => r.pattern === normalized)) {
      setFormError('A rule for this pattern already exists.');
      return;
    }
    setFormError(null);
    const rule: SiteRule = {
      id: newProfileId(),
      pattern: normalized,
      targetProfileId: target === 'direct' ? null : target,
      enabled: true,
    };
    setPattern('');
    setTarget('direct');
    void runOp(() => ProxyService.addRule(rule));
  };

  const move = (id: string, dir: -1 | 1) => {
    void runOp(() => ProxyService.moveRule(id, dir));
  };

  const patch = (id: string, fn: (r: SiteRule) => SiteRule) => {
    const cur = rules.find((r) => r.id === id);
    if (!cur) return;
    const updated = fn(cur);
    void runOp(() =>
      ProxyService.patchRule(id, {
        pattern: updated.pattern,
        targetProfileId: updated.targetProfileId,
        enabled: updated.enabled,
      }),
    );
  };

  return (
    <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="rules-h">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 id="rules-h" className="text-sm font-semibold">Site Rules</h2>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={rulesEnabled}
            onChange={(e) => void runOp(() => ProxyService.setRulesEnabled(e.target.checked))}
          />
          Enable site rules
        </label>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-neutral-400">
        Route matching sites through a specific profile (or Direct) using a PAC script.
        Top rule wins. <code>*.example.com</code> matches subdomains only, not the apex.
        localhost, 127.0.0.1 and ::1 are always direct. Turn the switch off to return
        to normal global proxy behavior.
      </p>
      {applyError && (
        <p className="mb-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">
          {applyError}
        </p>
      )}

      {!rulesEnabled && rules.length > 0 && (
        <p className="mb-2 rounded-md bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          Site rules are currently disabled — the global proxy (or Direct) applies everywhere.
        </p>
      )}

      {rules.length > 0 && (
        <ul className="mb-3 divide-y divide-neutral-100 dark:divide-neutral-800">
          {rules.map((rule, i) => {
            const { label, missing } = ruleTargetLabel(rule, profiles);
            return (
              <li key={rule.id} className={`flex items-center gap-2 py-2 ${rule.enabled ? '' : 'opacity-50'}`}>
                <span className="w-5 shrink-0 text-[11px] font-semibold text-neutral-400" title={`Priority ${i + 1}`}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{rule.pattern}</p>
                  <p className={`text-[11px] ${missing ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-400'}`}>
                    → {label}
                    {!rule.enabled && ' · disabled'}
                  </p>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-neutral-500">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => patch(rule.id, (r) => ({ ...r, enabled: e.target.checked }))}
                    aria-label={`Enable rule for ${rule.pattern}`}
                  />
                  On
                </label>
                <select
                  value={rule.targetProfileId ?? 'direct'}
                  onChange={(e) =>
                    patch(rule.id, (r) => ({
                      ...r,
                      targetProfileId: e.target.value === 'direct' ? null : e.target.value,
                    }))
                  }
                  aria-label={`Target for ${rule.pattern}`}
                  className="max-w-28 rounded-md border border-neutral-300 bg-white px-1 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800"
                >
                  <option value="direct">Direct</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="flex shrink-0 flex-col">
                  <button
                    onClick={() => move(rule.id, -1)}
                    disabled={i === 0}
                    title="Move up (higher priority)"
                    aria-label={`Move rule ${rule.pattern} up`}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                  >
                    <ArrowUp size={12} aria-hidden />
                  </button>
                  <button
                    onClick={() => move(rule.id, 1)}
                    disabled={i === rules.length - 1}
                    title="Move down (lower priority)"
                    aria-label={`Move rule ${rule.pattern} down`}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                  >
                    <ArrowDown size={12} aria-hidden />
                  </button>
                </div>
                <button
                  onClick={() => void runOp(() => ProxyService.deleteRule(rule.id))}
                  title="Delete rule"
                  aria-label={`Delete rule for ${rule.pattern}`}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-red-500 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-lg bg-neutral-50 p-2.5 dark:bg-neutral-800/60">
        <div className="flex gap-1.5">
          <div className="flex-1">
            <label htmlFor="rule-pattern" className="sr-only">Domain pattern</label>
            <input
              id="rule-pattern"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setFormError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRule();
                }
              }}
              placeholder="chatgpt.com or *.youtube.com"
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800"
            />
          </div>
          <label htmlFor="rule-target" className="sr-only">Rule target</label>
          <select
            id="rule-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="direct">Direct</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={addRule}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <Plus size={13} aria-hidden /> Add
          </button>
        </div>
        {formError && <p className="mt-1 text-xs text-red-500">{formError}</p>}
      </div>
    </section>
  );
}
