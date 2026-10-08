# Permissions (least-privilege audit)

Manifest: `public/manifest.json`. Every permission below is required by an
implemented feature. No permission is requested for future use. The extension
does NOT request `tabs`, history, bookmarks, cookies, or browsing-data access.

## `proxy`

- **Why:** the entire product. Applies the user-selected proxy configuration
  (`chrome.proxy.settings.set`), clears it for Direct mode
  (`chrome.proxy.settings.clear`), and reads `levelOfControl` to detect
  conflicts with other extensions or browser policy.
- **Used by:** `src/services/ProxyService.ts`, background startup reconcile.
- **User data accessible:** the browser's proxy configuration only. No browsing
  content, history, or page data.

## `storage`

- **Why:** persists proxy profiles, favorites, recents, test history, and
  settings locally (`chrome.storage.local`, versioned `state` object).
- **Used by:** `src/storage/StorageService.ts` (+ background reads for auth/badge).
- **User data accessible:** only data the user entered into the extension.

## `webRequest` + `webRequestAuthProvider`

- **Why:** supplies the saved username/password when the active HTTP/HTTPS
  proxy issues an authentication challenge
  (`chrome.webRequest.onAuthRequired` with `asyncBlocking` in the service
  worker). This is the only MV3-compatible proxy-auth mechanism; header
  modification and blocking web-request handlers are NOT used.
- **Used by:** `src/background/background.ts` (proxy challenges only —
  `details.isProxy` is checked; origin-server challenges are ignored).
- **User data accessible:** the handler reads the requesting URL's hostname
  transiently to select the site-rule/default proxy, then returns credentials
  to the matching challenging proxy. It does not store browsing history or
  read request bodies or page content.

## Host permission `<all_urls>`

- **Why (two concrete reasons):**
  1. `onAuthRequired` only fires for URLs covered by host permissions — without
     it, proxy authentication would silently never trigger on most sites.
  2. The manual connection test fetches the public IP from
     `https://api.ipify.org?format=json`, strictly on user click (Test/Check).
- **NOT used for:** content scripts (there are none), reading page content,
  tracking navigation, or background polling.

## Deliberately NOT requested

`tabs`, `history`, `bookmarks`, `cookies`, `management`, `declarativeNetRequest`,
`scripting`, `identity`, externally-connectable endpoints. There is no remote
code, no analytics, and no telemetry, so no permission exists to support them.
