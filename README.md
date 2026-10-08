# OnlyProxy (Edge / Chromium, MV3)

A lightweight personal proxy switcher: save multiple proxy profiles and switch between them from the popup.

- Popup: active proxy, Direct Connection, one-click switching, per-proxy test, add/edit/duplicate/delete
- Options page: full profile management, theme, privacy toggles, JSON import/export, bulk text import- Stack: Manifest V3, TypeScript, React, Vite, Tailwind CSS, Lucide icons
- Storage: everything local via `chrome.storage` — profiles survive browser restarts, and the active configuration is remembered and re-applied on startup
- Tests: `npm test` (vitest unit tests for parser, validation, storage migration, import/export)

## Project structure

```
public/
  manifest.json        # MV3 manifest (copied to dist/)
  icons/               # PNG icons 16/48/128 (generated: npm run icons)
  _locales/en/         # store listing name/description (default_locale)
src/
  popup/               # popup entry + UI (index.html): search, favorites, recents, verified state
  options/             # settings page entry + UI (options.html): import preview, add/replace
  welcome/             # first-run onboarding (welcome.html)
  background/          # MV3 service worker (proxy auth + startup re-apply + badge)
  components/          # shared UI (ProxyForm with quick-add)
  services/            # ProxyService (conflict detection, badge), IpService (swappable provider)
  storage/             # StorageService (versioned state + legacy migration)
  hooks/               # useTheme (light/dark/system)
  utils/               # validation, bulk import parser, transfer (export/import)
  types.ts
scripts/
  generate-icons.mjs   # dependency-free radar icon rasterizer
  package.mjs          # dependency-free store zip packager
store/
  assets/logo-300.png  # 300x300 store logo
AUDIT.md               # pre-publication audit
PERMISSIONS.md         # least-privilege justification per permission
PRIVACY_POLICY.md      # host this for the Privacy Policy URL
STORE_RELEASE.md       # Partner Center submission kit + asset checklist
CERTIFICATION_NOTES.md # notes for the store reviewer
```

## Install dependencies

```bash
npm install
```

## Development mode

```bash
npm run dev
```

This starts Vite for UI iteration only. The extension APIs (`chrome.proxy`, `chrome.storage`) are unavailable on a plain web page — the app falls back to `localStorage` so popup/options render, but actual proxy switching requires loading the built extension (below).

## Build

```bash
npm run build   # tsc + vite build -> dist/
npm test        # vitest unit tests
```

`dist/` is the unpacked extension (popup, options page, `background.js`, manifest, icons).

## Load the unpacked extension in Microsoft Edge

1. Build: `npm run build`
2. Open `edge://extensions/`
3. Enable **Developer mode** (bottom-left)
4. Click **Load unpacked** and select the `dist/` folder
5. Pin the extension, then click its toolbar icon to open the popup
6. After changing code, rebuild and click **Reload** on `edge://extensions/`

## Permissions used (and why)

| Permission | Why |
|---|---|
| `proxy` | Read/apply proxy settings via `chrome.proxy` — the core feature |
| `storage` | Persist profiles + settings locally (`chrome.storage.local`) |
| `webRequest` + `webRequestAuthProvider` | Supply HTTP/HTTPS proxy credentials in the background via `chrome.webRequest.onAuthRequired` (MV3-safe; header modification is NOT used) |
| `host_permissions: <all_urls>` | Required for `onAuthRequired` to fire on proxy challenges, and for the manual "Test/Check" IP lookup (`api.ipify.org`) |

No remote JavaScript, no `eval()`, no analytics, no background polling. The IP check runs only when you click Test/Check. Passwords are never logged.

## Browser behavior & limitations (verified, not worked around)

**SOCKS5 username/password authentication is NOT supported by Chromium/Edge extensions.**
Chromium explicitly implements no SOCKS5 auth (`crbug.com/1309413`); credentials embedded in proxy settings are ignored and `onAuthRequired` never fires for SOCKS. The extension stores SOCKS usernames/passwords (for export/portability) but the browser will ignore them — the UI warns about this in the proxy form, and the README states it plainly instead of faking success.

**SOCKS4** has no authentication in the protocol — username/password fields are meaningless for SOCKS4 and equally ignored.

**HTTP/HTTPS proxy auth works**: the background service worker answers proxy (`isProxy`) challenges from the remembered active profile. It re-arms on every service-worker start (`onInstalled`/`onStartup`/message) because MV3 service workers are ephemeral. Requires Edge/Chrome ≥ 123 for the reliable MV3 `asyncBlocking` behavior.

**Proxy persistence**: `chrome.proxy` settings (scope `regular`) persist across restarts, and the extension additionally remembers `activeProfileId` and re-applies it on startup so the popup and the real configuration agree. "Direct Connection" calls `chrome.proxy.settings.clear()` to release extension routing and return to the browser default/system connection — which may itself use a proxy, so it is labeled "browser default", never "no proxy".

**Testing activates the proxy**: extension-page fetches obey the active proxy, so there is no way to probe an idle profile. Clicking a profile's Test button activates that profile first, then runs the IP/latency check against `api.ipify.org`. The result is only saved as that profile's verification when the tested route demonstrably held for the whole check (same active profile and config, site rules still resolving `api.ipify.org` to it, extension still owning the proxy); otherwise the result is discarded as unverified.

## Bulk import formats

One proxy per line (`#` comments and blank lines skipped):

```
185.1.2.3:1080
45.4.5.6:8080:user:pass
user:pass@7.8.9.0:1080
http://11.22.33.44:8080
socks5://user:pass@55.66.77.88:1080
```

Lines without a scheme use the selected default protocol. The preview marks each line valid/invalid before anything is imported.

## Site Rules

Settings → Site Rules routes matching sites through a chosen profile (or Direct)
using a browser-native PAC script — no per-tab hacks, no background polling.

- Rule = domain pattern + target (profile or Direct) + on/off + priority order.
- Patterns: exact (`chatgpt.com`) or leading wildcard (`*.youtube.com`, which
  matches subdomains only — not the apex, same as PAC `shExpMatch`).
- First enabled match wins (top of the list = highest priority); drag order
  with the up/down arrows. Everything else uses the global profile (or Direct).
- `localhost`, `127.0.0.1`, and `::1` are always direct (built into the PAC).
- The master **Enable site rules** switch turns all routing off at once and
  returns to normal global proxy behavior. The popup shows "Site rules on" with
  a Manage link while active.
- Authenticated HTTP/HTTPS rule targets are authenticated automatically (the
  background worker matches the challenging proxy by host+port). SOCKS
  limitations from above apply unchanged.
- No new permissions: PAC routing uses the existing `proxy` permission.

## Security notes

- Passwords stored in `chrome.storage.local` (needed so the background worker can answer auth challenges after restarts). This is plaintext local storage — expected for this use case, but don't sync it anywhere untrusted.
- JSON export **excludes passwords by default** (opt-in checkbox).
- Host/port are validated; credentials are never logged or sent anywhere except the proxy challenge response.

## Publishing to Microsoft Edge Add-ons

Prepared per [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension):

```bash
npm run package   # builds + writes release/onlyproxy-<version>.zip
```

- The zip has extension files at the archive **root** (`manifest.json` on top level) — exactly what Partner Center's Upload page expects.
- Manifest meets store standards: PNG icons (16/48/128), `default_locale: "en"` with `_locales/en/messages.json` (i18n `__MSG_` name/description so Partner Center detects locales), MV3 with no remote code. Justifications: PERMISSIONS.md.
- `store/listing.md` has every form answer ready to paste: single-purpose description, per-permission justifications, remote-code declaration, store description (250+ chars), search terms, and certification notes.
- `store/privacy-policy.md` is the privacy policy text — host it at a public URL and paste it as the Privacy Policy URL. Replace the contact placeholder first.
- `store/assets/logo-300.png` is the 300×300 store logo. Captures still TODO: screenshots (1280×800 or 640×480, max 6), optional promo tiles (440×280, 1400×560).
- Full kit: STORE_RELEASE.md (all answers + checklist), CERTIFICATION_NOTES.md (reviewer notes), PERMISSIONS.md, PRIVACY_POLICY.md (host it, paste URL).
- Bump `version` in `public/manifest.json` for each update submission. Certification can take up to ~7 business days.

## License

[CC BY-NC 4.0](LICENSE) © 2026 Thehassanzadeh — free for personal, educational, and non-commercial use. Commercial use is not allowed without permission.
