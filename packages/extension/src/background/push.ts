// Keeping the badge and any open modal in step with the report.

import type { TabReport, View } from "../types.ts";
import { issueCount, overallTone, rowsFor } from "../ui/view.ts";
import { workerStatus } from "./anon.ts";
import { getSettings } from "./settings.ts";
import { getReport } from "./state.ts";

const COLORS = { good: "#1a7f37", warn: "#9a6700", bad: "#cf222e" } as const;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const lastCodeState = new Map<number, string>();

export async function viewFor(report: TabReport): Promise<View> {
  return { report, status: workerStatus(), settings: await getSettings() };
}

/** Debounced: a busy dapp changes its report many times a second. */
export function scheduleRefresh(tabId: number): void {
  if (timers.has(tabId)) return;
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void refresh(tabId);
    }, 300),
  );
}

export function forgetTab(tabId: number): void {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  lastCodeState.delete(tabId);
}

async function refresh(tabId: number): Promise<void> {
  const report = await getReport(tabId).catch(() => null);
  if (!report) return;
  const view = await viewFor(report);
  await paintBadge(tabId, view);
  if (!report.dapp) return;

  // A code mismatch is the one thing worth interrupting for, even if the
  // modal was already shown today or dismissed for this site.
  const previous = lastCodeState.get(tabId);
  lastCodeState.set(tabId, report.code.state);
  const forceShow = report.code.state === "mismatch" && previous !== "mismatch" && view.settings.alerts === "modal";
  await chrome.tabs.sendMessage(tabId, { type: "report", view, forceShow }).catch(() => {});
}

async function paintBadge(tabId: number, view: View): Promise<void> {
  let text = "";
  let color: string = COLORS.good;
  if (view.report.dapp) {
    const rows = rowsFor(view);
    const tone = overallTone(rows);
    if (tone === "bad") [text, color] = ["!", COLORS.bad];
    else if (tone === "warn") [text, color] = [String(issueCount(rows)), COLORS.warn];
    else if (tone === "good") [text, color] = ["✓", COLORS.good];
  }
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }).catch(() => {});
}
