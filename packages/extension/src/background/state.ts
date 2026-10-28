// Per-tab reports. Held in memory, mirrored to session storage because MV3
// stops an idle service worker after ~30 s and module state goes with it.
// Session storage is cleared when the browser closes: the right lifetime for
// what amounts to a browsing log.

import { siteOf } from "../../../core/src/site.ts";
import type { TabReport } from "../types.ts";

const reports = new Map<number, TabReport>();
const loading = new Map<number, Promise<TabReport>>();
const persistTimers = new Map<number, ReturnType<typeof setTimeout>>();
let onChange: (tabId: number, report: TabReport) => void = () => {};

const storageKey = (tabId: number) => `report:${tabId}`;

export function setChangeListener(fn: (tabId: number, report: TabReport) => void): void {
  onChange = fn;
}

export function emptyReport(tabId: number, url: string): TabReport {
  let site = "";
  try {
    site = siteOf(new URL(url).hostname);
  } catch {
    // about:blank, chrome:// and friends have no site
  }
  return {
    tabId,
    site,
    url,
    startedAt: Date.now(),
    dapp: false,
    rpc: {
      calls: 0,
      routed: 0,
      cached: 0,
      failed: 0,
      direct: 0,
      withAddress: 0,
      failovers: 0,
      latencyTotal: 0,
      latencyCount: 0,
      providers: {},
      keys: [],
      walletReads: 0,
      websockets: [],
    },
    thirdParties: {},
    meta: { fingerprint: {}, refererLeaks: [], thirdPartyCookies: 0 },
    code: { state: "pending" },
  };
}

export async function getReport(tabId: number): Promise<TabReport> {
  const held = reports.get(tabId);
  if (held) return held;
  let p = loading.get(tabId);
  if (!p) {
    p = (async () => {
      const stored = (await chrome.storage.session.get(storageKey(tabId)))[storageKey(tabId)] as TabReport | undefined;
      const report = stored ?? emptyReport(tabId, (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "");
      if (!reports.has(tabId)) reports.set(tabId, report);
      return reports.get(tabId)!;
    })().finally(() => loading.delete(tabId));
    loading.set(tabId, p);
  }
  return p;
}

/** A new top-level navigation starts a new report. */
export function resetReport(tabId: number, url: string): void {
  const report = emptyReport(tabId, url);
  reports.set(tabId, report);
  schedulePersist(tabId);
  onChange(tabId, report);
}

export async function mutateReport(tabId: number, fn: (report: TabReport) => void): Promise<TabReport> {
  const report = await getReport(tabId);
  fn(report);
  schedulePersist(tabId);
  onChange(tabId, report);
  return report;
}

export function dropReport(tabId: number): void {
  reports.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  void chrome.storage.session.remove(storageKey(tabId));
}

export function forgetAllReports(): void {
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  reports.clear();
}

function schedulePersist(tabId: number): void {
  if (persistTimers.has(tabId)) return;
  persistTimers.set(
    tabId,
    setTimeout(() => {
      persistTimers.delete(tabId);
      const report = reports.get(tabId);
      if (report) void chrome.storage.session.set({ [storageKey(tabId)]: report });
    }, 750),
  );
}
