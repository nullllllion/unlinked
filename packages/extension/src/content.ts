// The isolated-world content script: the trusted half of the page-side code.
// Page scripts can't reach this world, so the asset hashing and the modal live
// here, while main-world.ts only reports.

import { sha256Hex } from "../../core/src/manifest.ts";
import { PAGE_TAG, type AssetHash, type DappReply, type ExtPush, type ExtRequest, type RpcReply } from "./types.ts";
import { Modal } from "./ui/modal.ts";

const MAX_ASSETS = 60;
const OBSERVE_BEFORE_MODAL_MS = 2_500;

const ask = <T = unknown>(msg: ExtRequest): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;
const quietly = (p: Promise<unknown>) => p.catch(() => {});

const modal = new Modal({
  details: () => void quietly(ask({ type: "modal", action: "details" })),
  hide: () => void quietly(ask({ type: "modal", action: "hide" })),
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data as Record<string, unknown> | null;
  if (!d || d.tag !== PAGE_TAG || d.dir !== "toExt") return;
  switch (d.kind) {
    case "rpc":
      void relayRpc(Number(d.id), String(d.url), String(d.body));
      break;
    case "accounts":
      if (Array.isArray(d.accounts)) void quietly(ask({ type: "accounts", accounts: d.accounts.map(String) }));
      break;
    case "walletRead":
      void quietly(ask({ type: "walletRead", method: String(d.method) }));
      break;
    case "fingerprint":
      if (d.counts && typeof d.counts === "object") void quietly(ask({ type: "fingerprint", counts: sanitizeCounts(d.counts) }));
      break;
    case "dapp":
      onDapp();
      break;
  }
});

async function relayRpc(id: number, url: string, body: string): Promise<void> {
  let reply: RpcReply;
  try {
    reply = (await ask<RpcReply | undefined>({ type: "rpc", url, body })) ?? { passthrough: true };
  } catch {
    // The extension was reloaded or removed under this page: get out of the way.
    reply = { passthrough: true };
  }
  window.postMessage({ tag: PAGE_TAG, dir: "toPage", kind: "rpc:res", id, reply }, "*");
}

let dappSeen = false;

function onDapp(): void {
  if (dappSeen) return;
  dappSeen = true;
  afterLoad(async () => {
    void hashAssets().then((assets) => quietly(ask({ type: "assets", assets })));
    await new Promise((r) => setTimeout(r, OBSERVE_BEFORE_MODAL_MS));
    const reply = await ask<DappReply>({ type: "dapp" }).catch(() => null);
    if (reply?.show) modal.show(reply);
  });
}

chrome.runtime.onMessage.addListener((msg: ExtPush) => {
  if (msg?.type !== "report") return;
  if (modal.open) modal.update(msg.view);
  else if (msg.forceShow) modal.show(msg.view);
});

/**
 * Hash the scripts and stylesheets this page loaded. A content-script fetch is
 * made on the page's behalf, so `force-cache` should be answered from the same
 * HTTP cache entry the page just used: the bytes that actually ran, not a
 * second download a server could tailor. Cross-origin files without CORS
 * can't be read and are reported as unreadable rather than guessed at.
 */
async function hashAssets(): Promise<AssetHash[]> {
  const urls = new Set<string>();
  for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) urls.add(s.src);
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href], link[rel="stylesheet"][href]')) urls.add(l.href);
  for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    if (e.initiatorType === "script" || /\.(m?js|css|wasm)(\?|#|$)/.test(e.name)) urls.add(e.name);
  }
  const list = [...urls].filter((u) => u.startsWith("https:") || u.startsWith("http:")).slice(0, MAX_ASSETS);
  return Promise.all(
    list.map(async (url): Promise<AssetHash> => {
      try {
        const res = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
        if (!res.ok) return { url, sha256: null };
        return { url, sha256: await sha256Hex(new Uint8Array(await res.arrayBuffer())) };
      } catch {
        return { url, sha256: null };
      }
    }),
  );
}

function sanitizeCounts(counts: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (/^[a-z]{1,16}$/.test(k) && Number.isFinite(v)) out[k] = Math.min(Number(v), 1e6);
  }
  return out;
}

function afterLoad(fn: () => void): void {
  if (document.readyState === "complete") setTimeout(fn, 500);
  else window.addEventListener("load", () => setTimeout(fn, 500), { once: true });
}
