// Runs in the page's own JavaScript world at document_start, before any page
// script. Three jobs:
//
//   1. Catch JSON-RPC bodies sent with fetch and hand them to the extension,
//      which sends them through anon-rpc. viem, ethers v5/v6 and web3.js v4 all
//      use fetch in the browser; XHR is not intercepted.
//   2. Watch wallet providers passively, to learn the user's accounts and to
//      count reads that go through the wallet's own RPC (which no other
//      extension can reroute).
//   3. Count fingerprinting APIs.
//
// Nothing here is trusted by the extension. Page scripts share this world and
// could forge or suppress any of it, so the service worker treats it as
// page-reported. Wrappers are Proxies over the originals so they keep native
// `toString` output, which makes Unlinked less of a fingerprint itself.

import { isChainRead, parseJsonRpc } from "../../core/src/jsonrpc.ts";
import { PAGE_TAG, type RpcReply } from "./types.ts";

const nativeFetch = window.fetch;
const post = window.postMessage.bind(window);
const later = window.setTimeout.bind(window);
const decoder = new TextDecoder();

const REPLY_TIMEOUT_MS = 180_000;

const pending = new Map<number, (reply: RpcReply) => void>();
let seq = 0;
let dappAnnounced = false;

function send(kind: string, data: Record<string, unknown> = {}): void {
  post({ tag: PAGE_TAG, dir: "toExt", kind, ...data }, "*");
}

function markDapp(): void {
  if (dappAnnounced) return;
  dappAnnounced = true;
  send("dapp");
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data as { tag?: string; dir?: string; kind?: string; id?: number; reply?: RpcReply } | null;
  if (!d || d.tag !== PAGE_TAG || d.dir !== "toPage" || d.kind !== "rpc:res" || typeof d.id !== "number") return;
  const resolve = pending.get(d.id);
  if (resolve && d.reply) {
    pending.delete(d.id);
    resolve(d.reply);
  }
});

/* --- 1. fetch ------------------------------------------------------------ */

async function asJsonRpc(input: RequestInfo | URL, init?: RequestInit): Promise<{ url: string; body: string } | null> {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "POST") return null;

  let url: string;
  try {
    url = new URL(request ? request.url : input instanceof URL ? input.href : String(input), location.href).href;
  } catch {
    return null;
  }
  if (!url.startsWith("https:") && !url.startsWith("http:")) return null;

  let text: string | null = null;
  const body = init?.body;
  if (body !== undefined && body !== null) {
    if (typeof body === "string") text = body;
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = decoder.decode(body);
    else if (body instanceof Blob) text = await body.text();
    else return null; // FormData, URLSearchParams, streams: never JSON-RPC
  } else if (request?.body) {
    text = await request.clone().text();
  }
  return text !== null && parseJsonRpc(text) ? { url, body: text } : null;
}

async function unlinkedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const call = await asJsonRpc(input, init);
  if (!call) return Reflect.apply(nativeFetch, window, [input, init]) as Promise<Response>;
  markDapp();

  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

  const id = ++seq;
  const reply = await new Promise<RpcReply>((resolve, reject) => {
    pending.set(id, resolve);
    const timer = later(() => {
      if (pending.delete(id)) reject(new TypeError("Failed to fetch"));
    }, REPLY_TIMEOUT_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        if (pending.delete(id)) reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
    send("rpc", { id, url: call.url, body: call.body });
  });

  if (reply.passthrough) return Reflect.apply(nativeFetch, window, [input, init]) as Promise<Response>;
  const status = reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
  return new Response(reply.body, { status, headers: reply.headers });
}

window.fetch = new Proxy(nativeFetch, {
  apply: (_target, _self, args: [RequestInfo | URL, RequestInit?]) => unlinkedFetch(args[0], args[1]),
});

/* --- 2. wallet providers (observe only) ---------------------------------- */

type Eip1193 = {
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
};

const observed = new WeakSet<object>();

function reportAccounts(value: unknown): void {
  if (Array.isArray(value)) send("accounts", { accounts: value.filter((a) => typeof a === "string") });
}

function observeProvider(candidate: unknown): void {
  const provider = candidate as Eip1193 | null;
  if (!provider || typeof provider.request !== "function" || observed.has(provider)) return;
  observed.add(provider);
  try {
    provider.request = new Proxy(provider.request, {
      apply(target, self, args: [{ method?: unknown }]) {
        const result = Reflect.apply(target, self ?? provider, args) as Promise<unknown>;
        const method = args[0]?.method;
        if (typeof method === "string") {
          markDapp();
          if (method === "eth_accounts" || method === "eth_requestAccounts") Promise.resolve(result).then(reportAccounts, () => {});
          else if (isChainRead(method)) send("walletRead", { method });
        }
        return result;
      },
    });
  } catch {
    // A frozen provider: account events below still work.
  }
  try {
    provider.on?.("accountsChanged", reportAccounts);
  } catch {
    // Not every provider is an event emitter.
  }
}

window.addEventListener("eip6963:announceProvider", (event) => {
  observeProvider((event as CustomEvent<{ provider?: unknown }>).detail?.provider);
});
const checkInjected = () => observeProvider((window as unknown as { ethereum?: unknown }).ethereum);
window.addEventListener("ethereum#initialized", checkInjected, { once: true });
document.addEventListener("DOMContentLoaded", checkInjected, { once: true });
window.addEventListener("load", checkInjected, { once: true });

/* --- 3. fingerprinting signals ------------------------------------------- */

const fingerprint: Record<string, number> = {};
let flushTimer = 0;

function bump(api: string): void {
  fingerprint[api] = (fingerprint[api] ?? 0) + 1;
  if (flushTimer) return;
  flushTimer = later(() => {
    flushTimer = 0;
    send("fingerprint", { counts: { ...fingerprint } });
  }, 1_000);
}

function tap(proto: object | undefined, name: string, api: string, when?: (args: unknown[]) => boolean): void {
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc || typeof desc.value !== "function") return;
  Object.defineProperty(proto, name, {
    ...desc,
    value: new Proxy(desc.value, {
      apply(target, self, args: unknown[]) {
        if (!when || when(args)) bump(api);
        return Reflect.apply(target, self, args);
      },
    }),
  });
}

const UNMASKED_VENDOR = 0x9245;
const UNMASKED_RENDERER = 0x9246;
const unmasked = (args: unknown[]) => args[0] === UNMASKED_VENDOR || args[0] === UNMASKED_RENDERER;

tap(HTMLCanvasElement.prototype, "toDataURL", "canvas");
tap(HTMLCanvasElement.prototype, "toBlob", "canvas");
tap(CanvasRenderingContext2D.prototype, "getImageData", "canvas");
tap(WebGLRenderingContext.prototype, "getParameter", "webgl", unmasked);
tap(globalThis.WebGL2RenderingContext?.prototype, "getParameter", "webgl", unmasked);
if (typeof OfflineAudioContext === "function") {
  window.OfflineAudioContext = new Proxy(OfflineAudioContext, {
    construct(target, args: unknown[], newTarget) {
      bump("audio");
      return Reflect.construct(target, args, newTarget);
    },
  });
}
