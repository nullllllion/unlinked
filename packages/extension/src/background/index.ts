// The service worker. Listeners are registered synchronously at the top level,
// as MV3 requires for them to wake a stopped worker.

import { siteOf } from "../../../core/src/site.ts";
import type { DappReply, ExtRequest, StateReply } from "../types.ts";
import { resetPool, setStatusListener, workerStatus } from "./anon.ts";
import { registerObservers } from "./observer.ts";
import { forgetTab, scheduleRefresh, viewFor } from "./push.ts";
import { clearRouterCaches, handleRpc } from "./router.ts";
import { getSettings, learnAccounts, patchSettings, wipeLocalData } from "./settings.ts";
import { dropReport, forgetAllReports, getReport, mutateReport, setChangeListener } from "./state.ts";
import { clearVerdicts, verifyAssets } from "./verifier.ts";

const DAY = 24 * 60 * 60 * 1000;
const MODAL_LOG = "modalShown";

registerObservers();
setChangeListener((tabId) => scheduleRefresh(tabId));
setStatusListener(() => {
  void chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => t.id !== undefined && scheduleRefresh(t.id)));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropReport(tabId);
  forgetTab(tabId);
});

chrome.runtime.onMessage.addListener((msg: ExtRequest, sender, respond) => {
  handle(msg, sender).then(respond, (err) => {
    console.warn("unlinked:", msg?.type, err);
    respond(undefined);
  });
  return true; // async response
});

const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));

async function handle(msg: ExtRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Settings and state are for Unlinked's own pages, never for content scripts.
  if (msg.type === "state" || msg.type === "settings" || msg.type === "wipe") {
    if (!fromExtensionPage(sender)) return undefined;
    return handleExtensionPage(msg);
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return msg.type === "rpc" ? { passthrough: true } : undefined;
  const report = await getReport(tabId);
  const site = report.site || siteOf(new URL(sender.url ?? "about:blank").hostname || "");

  switch (msg.type) {
    case "rpc":
      return handleRpc(tabId, site, msg.url, msg.body);
    case "accounts":
      await learnAccounts(msg.accounts);
      await mutateReport(tabId, (r) => void (r.dapp = true));
      return;
    case "walletRead":
      await mutateReport(tabId, (r) => void r.rpc.walletReads++);
      return;
    case "fingerprint":
      await mutateReport(tabId, (r) => void (r.meta.fingerprint = msg.counts));
      return;
    case "assets":
      await mutateReport(tabId, (r) => void (r.code = { state: "pending" }));
      void verifyAssets(tabId, site, msg.assets);
      return;
    case "dapp":
      return decideModal(tabId);
    case "modal":
      if (msg.action === "details") await chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${tabId}`) });
      else {
        const s = await getSettings();
        if (!s.hiddenSites.includes(site)) await patchSettings({ hiddenSites: [...s.hiddenSites, site] });
      }
      return;
  }
}

async function handleExtensionPage(msg: Extract<ExtRequest, { type: "state" | "settings" | "wipe" }>): Promise<StateReply | undefined> {
  if (msg.type === "settings") {
    const before = await getSettings();
    const after = await patchSettings(msg.patch);
    if (before.network !== after.network || before.strictIsolation !== after.strictIsolation || before.torGateways.join() !== after.torGateways.join()) {
      resetPool();
      clearRouterCaches();
    }
    if (before.trustedAttesters.join() !== after.trustedAttesters.join() || before.arkivRpc !== after.arkivRpc) clearVerdicts();
    return state(undefined);
  }
  if (msg.type === "wipe") {
    await wipeLocalData();
    forgetAllReports();
    clearRouterCaches();
    clearVerdicts();
    resetPool();
    return state(undefined);
  }
  return state(msg.tabId);
}

async function state(tabId: number | undefined): Promise<StateReply> {
  const settings = await getSettings();
  const report = tabId === undefined ? null : await getReport(tabId).catch(() => null);
  return { view: report ? await viewFor(report) : null, status: workerStatus(), settings };
}

/** Show the summary at most once per site per day, never where the user said not to. */
async function decideModal(tabId: number): Promise<DappReply> {
  const report = await mutateReport(tabId, (r) => void (r.dapp = true));
  const view = await viewFor(report);
  let show = view.settings.alerts === "modal" && !!report.site && !view.settings.hiddenSites.includes(report.site);
  if (show) {
    const now = Date.now();
    const log = ((await chrome.storage.local.get(MODAL_LOG))[MODAL_LOG] as Record<string, number> | undefined) ?? {};
    for (const [site, at] of Object.entries(log)) if (now - at > DAY) delete log[site];
    show = !(report.site in log);
    if (show) log[report.site] = now;
    await chrome.storage.local.set({ [MODAL_LOG]: log });
  }
  return { ...view, show };
}
