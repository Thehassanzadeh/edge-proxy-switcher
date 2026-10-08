# Store release — Microsoft Edge Add-ons submission

Source doc: [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).
Package: `npm run package` → `release/onlyproxy-<version>.zip` (files at
archive root, `manifest.json` on top level). Bump `version` in
`public/manifest.json` for each update. Review can take ~7 business days.

`name`/`description` in the manifest are read-only in Partner Center — edit
`public/_locales/en/messages.json` instead.

## Availability

- **Visibility:** Public (or Hidden for link-only distribution)
- **Markets:** all markets (default)

## Properties

- **Category:** Productivity
- **Website:** YOUR-WEBSITE-URL (optional, must be your own site)
- **Support contact:** YOUR-SUPPORT-URL-OR-EMAIL (optional)
- **Mature content:** unchecked

## Privacy page

### Single-purpose description

> OnlyProxy lets users save multiple proxy profiles (HTTP, HTTPS, SOCKS4,
> SOCKS5) and switch between them in one click from the toolbar popup, or return
> to the browser default connection. All profiles and settings are stored locally on the device.

### Permission justifications

- **proxy** — Core functionality: applies the selected proxy configuration and
  clears it for Direct mode; reads control state for conflict detection.
- **storage** — Persists profiles, favorites, settings locally.
- **webRequest** + **webRequestAuthProvider** — Answers HTTP/HTTPS proxy auth
  challenges in the background. No content read or modified.
- **Host permission `<all_urls>`** — Lets the auth handler fire on any site and
  lets the manual connection test reach the IP-check service.

Full audit: PERMISSIONS.md.

### Remote code

**No.** MV3, all code bundled. (The manual IP test fetches data only, never code.)

### Data usage / privacy disclosure

No analytics, no telemetry, no browsing-history collection. Profiles and
credentials stay in local storage. The only network request the extension makes
is the manual IP check (`https://api.ipify.org?format=json`) on user click.
Basis for the policy page: PRIVACY_POLICY.md (host it, paste URL).

## Store listing (English)

### Extension name

`OnlyProxy`

### Short description (from manifest)

`Save multiple proxy profiles and switch between them in one click.`

### Full description (250–10,000 chars)

> OnlyProxy is a lightweight utility for anyone who works with multiple
> proxy servers. Save your proxy profiles once — HTTP, HTTPS, SOCKS4, SOCKS5,
> with optional authentication — then switch between them in a single click
> from the toolbar popup. No clutter, no background activity, no accounts.
>
> KEY FEATURES
> - One-click switching between saved proxies and Direct Connection
> - Manual connection test: status, latency, public IP, timestamp
> - Favorites, recent list, and search for large profile lists
> - Add, edit, duplicate, delete with validation; quick-add from a pasted string
> - JSON import/export with preview (passwords excluded by default) and bulk
>   text import
> - Compact popup with light, dark, and system themes
> - Site rules: route specific domains through specific proxies via PAC script
> - Conflict detection when another extension or policy controls proxy settings
> - Everything stored locally — no tracking, no analytics
>
> AUTHENTICATION NOTE
> HTTP and HTTPS proxies with a username and password are authenticated
> automatically in the background. Platform limitation: Microsoft Edge and
> Chromium do not support SOCKS5 username/password authentication for
> extensions, so SOCKS credentials are stored but cannot be applied by any
> extension. Unauthenticated SOCKS4/SOCKS5 and all HTTP/HTTPS proxies work
> normally.

### Search terms (≤7 terms, ≤30 chars each)

> proxy switcher, proxy manager, socks5 proxy, http proxy, ip checker

## Store assets checklist

| Asset | Spec | Status |
|---|---|---|
| Manifest icons | PNG 16/48/128 | ✅ `public/icons/` (generated via `npm run icons`) |
| Extension logo | 1:1, 300×300 recommended (min 128) | ✅ `store/assets/logo-300.png` |
| Small promotional tile | 440×280 PNG (optional) | TODO |
| Large promotional tile | 1400×560 PNG (optional) | TODO |
| Screenshots (max 6) | 1280×800 or 640×480 | TODO — capture real UI, do not fake: |
| | 1. Main popup with active proxy | |
| | 2. Adding a SOCKS5 proxy (quick-add) | |
| | 3. Settings / profile management | |
| | 4. Connection test result | |
| Privacy Policy URL | hosted policy page | TODO — host PRIVACY_POLICY.md |
| Support contact | URL or email | TODO — replace placeholder |
| Certification notes | paste on submit | ✅ CERTIFICATION_NOTES.md |

## Submit

Partner Center → Edge workspace → Create new extension → upload the zip →
Availability → Properties → Privacy → Store listings → Publish with
CERTIFICATION_NOTES.md pasted into **Notes for certification**.
