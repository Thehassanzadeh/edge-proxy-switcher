# Certification notes — OnlyProxy (for the Edge Add-ons reviewer)

## What the extension does

OnlyProxy lets users save multiple proxy profiles (HTTP, HTTPS, SOCKS4,
SOCKS5) and switch between them in one click from the toolbar popup, or return
to Direct Connection (browser default/system connection). All data stays in local browser storage.

## How to test (no account needed, works offline except the IP check)

1. Install the extension. A welcome page opens once, explaining the product.
2. Click the toolbar icon → **Add Proxy**. Enter e.g. protocol HTTP,
   host `127.0.0.1`, port `8080` — or paste a full proxy string into the
   "Quick add" field and click Fill.
3. Click the new profile in the list to **activate** it. The header badge shows
   ON and the status pill shows "Proxy Active".
4. Click the ⚡ **Test** icon on the profile (or **Check** in the header) to run
   the manual connection test: status, latency, public IP, timestamp.
5. Click **Direct Connection** to release extension routing and return to the browser default connection (badge clears).
6. Open the **Settings** (gear icon) for profile management, theme, JSON
   import/export with preview, and bulk text import with preview.
7. Settings → **Site Rules**: turn on "Enable site rules", add e.g.
   `*.example.com` → a proxy profile, then visit a matching subdomain to see
   it routed (unmatched sites keep using the global profile). Turn the master
   switch off to return to normal global behavior.

## Expected behaviors that are NOT defects

- **Authenticated SOCKS5 proxies cannot work.** Chromium/Edge implements no
  SOCKS5 authentication for extensions (crbug.com/1309413). The extension stores
  such credentials but the browser ignores them; the UI warns about this.
  Authenticated HTTP/HTTPS proxies work via the background auth handler.
- **Testing activates the profile first.** Extension-page network requests obey
  the active proxy, so probing an idle profile is impossible without switching.
- **Conflict banner.** If another extension or enterprise policy controls proxy
  settings, the popup explains this instead of failing silently.

## Data & external APIs

- No account required. No analytics or telemetry of any kind.
- Proxy profiles/credentials: local `chrome.storage.local` only.
- One external call, strictly manual: `GET https://api.ipify.org?format=json`
  when the user clicks Test/Check (returns the public IP as JSON). No proxy
  configuration or credentials are sent to that service.
- No remote executable code; Manifest V3; permissions justified in
  PERMISSIONS.md. Privacy policy basis: PRIVACY_POLICY.md.
