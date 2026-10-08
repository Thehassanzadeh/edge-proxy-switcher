# Privacy Policy — OnlyProxy

_Last updated: 2026-10-05. Host this file at a public URL for the Partner
Center **Privacy Policy URL** field. Replace the contact line before publishing._

## Overview

OnlyProxy ("the extension") runs entirely in your browser. It collects no
analytics, no telemetry, no browsing history, and no account data.

## Data stored on your device

- **Proxy profiles** (name, protocol, host, port, favorites) and any
  **username/password you enter**, plus **settings** (active profile, theme,
  display preferences) and **test history**, are saved in your browser's local
  extension storage (`chrome.storage.local`, never synced).
- Uninstalling the extension removes this data.
- **Credentials are stored as plain text in local browser storage**, which is
  required so the extension can authenticate to your proxy after a browser
  restart. Browser extension storage is not an encrypted password vault: anyone
  with access to your browser profile could read it. Only save credentials on
  devices you trust.

## Data that leaves your device

- **Proxy authentication:** when you use an HTTP/HTTPS proxy that requires a
  username and password, the extension supplies those credentials to that proxy
  server during its authentication challenge. This is the proxy's normal login
  flow and involves only the proxy server you configured. Credentials are never
  logged, never included in diagnostics, and never sent anywhere else.
- **Manual connection test:** only when you click Test/Check, the extension
  sends one HTTPS request to `https://api.ipify.org?format=json` to display
  your public IP and latency. That service technically receives the requester's
  IP address, as any website you visit would. No test runs automatically, in the
  background, or on a timer. No proxy configuration or credentials are sent to
  the IP service.

## What we don't do

- No accounts, analytics, tracking, advertising, third-party SDKs, or
  fingerprinting.
- No remote executable code: all extension code ships in the published package.
- No browsing-history, tab-content, or cookie collection (the extension has no
  content scripts and requests no such permissions).

## Contact

For privacy questions, contact: **YOUR-EMAIL-OR-SUPPORT-URL**
