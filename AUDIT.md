# Audit — Proxy Switcher (pre-publication review)

Date: 2026-10-05. Scope: manifest, permissions, proxy/auth, storage, popup,
options, service worker, import/export, external calls.

## What is already solid

- MV3 only, no remote code, no `eval`, no analytics, minimal dependencies.
- `chrome.proxy` isolated in `ProxyService`; storage isolated in `StorageService`.
- HTTP/HTTPS auth via `webRequest.onAuthRequired` + `webRequestAuthProvider`;
  SOCKS5-auth limitation documented, not faked.
- Test results are manual-only; popup renders from local storage.

## Problems found

### Reliability
1. **No conflict detection.** `levelOfControl` is read once (`isExtensionControlled`)
   but `controlled_by_other_extensions` / `not_controllable` (policy) are never
   surfaced. Switching can silently fail or misreport state.
2. **No external-change detection.** If the user/another extension alters proxy
   settings outside the popup, `activeProfileId` and reality diverge with no notice.
3. **Configured ≠ verified.** Selecting a profile only means "settings applied";
   the UI implies it works. No per-profile last-test persistence.
4. **Test errors are raw** ("Connection failed." / HTTP status) with no timestamps
   and no recovery path (no "Return to Direct" on failure).
5. **Unversioned storage.** Separate `profiles`/`settings` keys, no schema version,
   no migration path — a future update risks wiping or misreading user data.
6. **Service worker does not reconcile badge/state.** No action badge; startup
   re-apply exists but badge/UI sync does not.

### Security / certification risks
7. **Permissions are justifiable but undocumented in-repo** (`webRequest`,
   `webRequestAuthProvider`, `<all_urls>`). Reviewers will ask; needs PERMISSIONS.md.
   All three are genuinely required (proxy auth + manual IP test) — keep, don't cut.
8. **Credentials live in plaintext `chrome.storage.local`.** Acceptable and standard
   for proxy extensions, but must be stated honestly (not a vault) in privacy docs.
9. **Export includes usernames; passwords opt-in** — good, but no explicit warning
   that exported credentials are readable JSON.
10. **No first-run explanation** of what the extension controls; users may not
    understand Direct vs proxy or the SOCKS5-auth platform limit.
11. **Delete-active has no warning** — deleting the active proxy drops to Direct
    without telling the user first.

### UX
12. **No favorites / search / recents** — painful beyond a handful of profiles.
13. **All row actions always visible** (test/edit/duplicate/delete) — cluttered;
    secondary actions belong in an overflow menu.
14. **No quick-add-from-string** in the form; bulk import exists only in options.
15. **Import has no preview, no add-vs-replace choice, no validation gate** — one
    bad file can pollute the list.
16. **Current IP is not cached**, has no timestamp, and shares one-shot state.
17. **Status is color-dot only** in places; needs text labels (a11y).
18. Icon-only buttons lack `aria-label`s; focus states are browser-default only.
19. No empty-state guidance beyond one line; no onboarding page.

### Out of scope (deliberately not added)
Monitoring dashboards, VPN-style kill switches, auto-rotation, PAC editing,
per-site rules, sync, telemetry of any kind.

## Proposed changes (implemented after this audit)

1. Versioned single-object storage (`state`, `schemaVersion: 1`) + legacy migration.
2. `levelOfControl` conflict detection + external-change notice + badge (ON/proxy).
3. Persisted per-profile last test (status, latency, IP, timestamp) + friendly
   error mapping with expandable technical details.
4. Cached current-IP with manual refresh + swappable `IpService` provider.
5. Favorites (top section), search (shows when >4 profiles), recents (max 4,
   shows when >5 profiles), overflow menus, delete-active warning with Direct
   fallback, "Return to Direct" recovery on failures.
6. Quick-add string parsing pre-filling the form; import preview with
   add/replace + replace-confirmation; export warning for credentials.
7. `welcome.html` first-run onboarding (single screen, ~30s read).
8. A11y pass: labels, aria-labels, focus-visible rings, text+color status.
9. Docs: PERMISSIONS.md, PRIVACY_POLICY.md, STORE_RELEASE.md,
   CERTIFICATION_NOTES.md; vitest unit tests for parser/validation/migration/transfer.
