// What the tab sends to whom, observed by the browser rather than reported by
// the page: webRequest sees every request (observe-only in MV3), and the page
// has no way to hide from it. Anonymized calls never reach the network from
// the page, so they don't appear here — they're counted by the router.

import { bodyText, findOwnAddresses } from "../../../core/src/addresses.ts";
import { hostOf, isThirdParty } from "../../../core/src/site.ts";
import { trackerCategory } from "../../../core/src/trackers.ts";
import type { TabReport, ThirdParty } from "../types.ts";
import { ownAddresses } from "./settings.ts";
import { mutateReport, resetReport } from "./state.ts";

const ALL: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };
const MAX_BODY_SCAN = 64 * 1024;

export function registerObservers(): void {
  chrome.webRequest.onBeforeRequest.addListener((d) => void onRequest(d), ALL, ["requestBody"]);
  chrome.webRequest.onBeforeSendHeaders.addListener((d) => void onSendHeaders(d), ALL, ["requestHeaders", "extraHeaders"]);
  chrome.webRequest.onHeadersReceived.addListener((d) => void onHeaders(d), ALL, ["responseHeaders", "extraHeaders"]);
}

function party(r: TabReport, host: string): ThirdParty {
  return (r.thirdParties[host] ??= { host, requests: 0, category: trackerCategory(host), gotAddress: false, cookies: 0 });
}

async function onRequest(d: chrome.webRequest.OnBeforeRequestDetails): Promise<undefined> {
  if (d.tabId < 0 || d.initiator?.startsWith("chrome-extension://")) return;
  if (d.type === "main_frame") {
    resetReport(d.tabId, d.url);
    return;
  }
  const host = hostOf(d.url);
  if (!host) return;
  const own = await ownAddresses();
  const leaked = findOwnAddresses(d.url + "\n" + requestBodyText(d.requestBody), own).length > 0;
  await mutateReport(d.tabId, (r) => {
    if (d.type === "websocket" && !r.rpc.websockets.includes(host)) r.rpc.websockets.push(host);
    if (!r.site || !isThirdParty(host, r.site)) return;
    const p = party(r, host);
    p.requests++;
    if (leaked) p.gotAddress = true;
  }).catch(() => {});
}

async function onSendHeaders(d: chrome.webRequest.OnBeforeSendHeadersDetails): Promise<undefined> {
  if (d.tabId < 0 || d.type === "main_frame") return;
  const referer = d.requestHeaders?.find((h) => h.name.toLowerCase() === "referer")?.value;
  const host = hostOf(d.url);
  if (!referer || !host) return;
  if (findOwnAddresses(referer, await ownAddresses()).length === 0) return;
  await mutateReport(d.tabId, (r) => {
    if (!r.site || !isThirdParty(host, r.site)) return;
    if (!r.meta.refererLeaks.includes(host)) r.meta.refererLeaks.push(host);
    party(r, host).gotAddress = true;
  }).catch(() => {});
}

async function onHeaders(d: chrome.webRequest.OnHeadersReceivedDetails): Promise<undefined> {
  if (d.tabId < 0 || d.type === "main_frame") return;
  const cookies = d.responseHeaders?.filter((h) => h.name.toLowerCase() === "set-cookie").length ?? 0;
  const host = hostOf(d.url);
  if (!cookies || !host) return;
  await mutateReport(d.tabId, (r) => {
    if (!r.site || !isThirdParty(host, r.site)) return;
    party(r, host).cookies += cookies;
    r.meta.thirdPartyCookies += cookies;
  }).catch(() => {});
}

function requestBodyText(body: chrome.webRequest.OnBeforeRequestDetails["requestBody"]): string {
  if (!body) return "";
  if (body.formData) return Object.entries(body.formData).map(([k, v]) => `${k}=${v.join(",")}`).join("&");
  if (!body.raw) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const chunk of body.raw) {
    if (!chunk.bytes || size >= MAX_BODY_SCAN) continue;
    const bytes = new Uint8Array(chunk.bytes).subarray(0, MAX_BODY_SCAN - size);
    parts.push(bytes);
    size += bytes.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return bodyText(all);
}
