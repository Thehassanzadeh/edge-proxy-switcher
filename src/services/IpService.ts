import type { StoredTest } from '../types';
import { ProxyService } from './ProxyService';

const TIMEOUT_MS = 10_000;

export type TestCause = StoredTest['cause'];

export interface IpProvider {
  id: string;
  /** Returns the public IP as seen through the CURRENT connection. */
  fetchIp(signal: AbortSignal): Promise<string>;
}

/** Default provider: api.ipify.org over HTTPS, JSON, no caching. */
export const ipifyProvider: IpProvider = {
  id: 'ipify',
  async fetchIp(signal: AbortSignal): Promise<string> {
    const res = await fetch('https://api.ipify.org?format=json', { signal, cache: 'no-store' });
    if (!res.ok) {
      throw new IpServiceError('ip-service', `IP service unavailable (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { ip?: unknown };
    if (typeof data.ip !== 'string' || !data.ip) {
      throw new IpServiceError('ip-service', 'IP service returned an unexpected response.');
    }
    return data.ip;
  },
};

export class IpServiceError extends Error {
  causeCode: Exclude<TestCause, undefined>;
  constructor(causeCode: Exclude<TestCause, undefined>, message: string) {
    super(message);
    this.causeCode = causeCode;
  }
}

/** Friendly, non-technical messages per cause. */
export function friendlyTestError(cause: TestCause, detail?: string): string {
  switch (cause) {
    case 'timeout':
      return 'Connection timed out. The proxy server may be slow or unreachable.';
    case 'unreachable':
      return 'Proxy server unreachable. Check the host, port, and your network.';
    case 'rejected':
      return 'Browser rejected the proxy settings. Check host and port.';
    case 'config':
      return 'Invalid proxy configuration.';
    case 'ip-service':
      return detail ?? 'External IP service unavailable.';
    default:
      return detail ?? 'Connection failed.';
  }
}

/**
 * Manual connectivity check only — never called in the background.
 * The request goes through the *currently active* proxy (extension-page
 * fetches respect chrome.proxy settings), so testing a profile means
 * activating it first (see callers).
 *
 * Sends: one HTTPS GET to the provider (currently api.ipify.org). The provider
 * technically sees the requester's IP, as with any site visited through the
 * proxy. No proxy configuration or credentials are ever sent anywhere.
 */
export const IpService = {
  provider: ipifyProvider as IpProvider,

  async testCurrentConnection(): Promise<StoredTest> {
    const started = performance.now();
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const ip = await IpService.provider.fetchIp(ctrl.signal);
      return { ok: true, ip, latencyMs: Math.round(performance.now() - started), at: Date.now() };
    } catch (e) {
      if (e instanceof IpServiceError) {
        return { ok: false, at: Date.now(), cause: e.causeCode, detail: e.message };
      }
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { ok: false, at: Date.now(), cause: 'timeout', detail: 'Timed out after 10s.' };
      }
      return { ok: false, at: Date.now(), cause: 'unreachable', detail: 'Network request failed.' };
    } finally {
      window.clearTimeout(timer);
    }
  },

  /** Persisted last-test bookkeeping (profile id, or "direct"). */
  async saveTest(key: string, test: StoredTest): Promise<void> {
    // Route through the single mutation owner so a concurrent routing change
    // cannot be overwritten by a stale whole-state snapshot.
    await ProxyService.dispatchOp({ kind: 'saveTest', key, test });
  },

  async saveCurrentIp(test: StoredTest): Promise<void> {
    await ProxyService.dispatchOp({ kind: 'saveCurrentIp', test });
  },
};
