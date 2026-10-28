// Types shared by the page scripts, the service worker and the UI.

import type { AssetHash, CodeVerdict, TrackerCategory } from "../../core/src/index.ts";

export type { AssetHash, CodeVerdict, TrackerCategory };

export type NetworkId = "tor" | "nym" | "passthrough";

export type Settings = {
  network: NetworkId;
  torGateways: string[];
  /** Boot several independent anon clients so isolation holds even on workers that ignore isolationKey. */
  strictIsolation: boolean;
  /** "modal" shows the in-page summary; "badge" keeps everything in the toolbar. */
  alerts: "modal" | "badge";
  /** When the anonymity network is down, send directly instead of failing. Off by default. */
  failOpen: boolean;
  disabledSites: string[];
  hiddenSites: string[];
  trustedAttesters: string[];
  manualAddresses: string[];
  arkivRpc: string;
};

export type WorkerStatus = {
  network: NetworkId;
  state: "idle" | "booting" | "ready" | "error";
  specifier: string;
  /** keccak256 of the running bundle, as read from the specifier contract. */
  pinnedHash?: string;
  bootMs?: number;
  /** The specifier read came from this install's cache, not a fresh, non-anonymous read. */
  bootstrapCached?: boolean;
  slots: number;
  error?: string;
};

export type ThirdParty = {
  host: string;
  requests: number;
  category: TrackerCategory | null;
  gotAddress: boolean;
  cookies: number;
};

export type RpcStats = {
  /** JSON-RPC calls the page made over fetch. */
  calls: number;
  /** Sent through the anonymity network. */
  routed: number;
  /** Answered from cache: never left the browser. */
  cached: number;
  /** Failed with no direct fallback. */
  failed: number;
  /** Sent directly because protection was off or fail-open kicked in. */
  direct: number;
  /** Calls naming one of the user's addresses. */
  withAddress: number;
  failovers: number;
  latencyTotal: number;
  latencyCount: number;
  /** Intended RPC host -> calls. */
  providers: Record<string, number>;
  /** Opaque isolation keys used: one per unlinked circuit identity. */
  keys: string[];
  /** Reads the page sent through the wallet's provider, which uses the wallet's own RPC. */
  walletReads: number;
  websockets: string[];
};

export type TabReport = {
  tabId: number;
  site: string;
  url: string;
  startedAt: number;
  /** The page touched a wallet or made JSON-RPC calls. */
  dapp: boolean;
  rpc: RpcStats;
  thirdParties: Record<string, ThirdParty>;
  meta: {
    /** API -> calls, as counted inside the page (best-effort: the page can hide from it). */
    fingerprint: Record<string, number>;
    refererLeaks: string[];
    thirdPartyCookies: number;
  };
  code: CodeVerdict;
};

/** Page scripts and the content script share this tag on window.postMessage. */
export const PAGE_TAG = "unlinked/v1";

export type RpcReply =
  | { passthrough: true }
  | { passthrough: false; status: number; headers: [string, string][]; body: string };

export type ExtRequest =
  | { type: "rpc"; url: string; body: string }
  | { type: "accounts"; accounts: string[] }
  | { type: "walletRead"; method: string }
  | { type: "fingerprint"; counts: Record<string, number> }
  | { type: "dapp" }
  | { type: "assets"; assets: AssetHash[] }
  | { type: "modal"; action: "details" | "hide" }
  | { type: "state"; tabId?: number }
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "wipe" };

export type View = { report: TabReport; status: WorkerStatus; settings: Settings };

export type DappReply = View & { show: boolean };

export type StateReply = { view: View | null; status: WorkerStatus; settings: Settings };

export type ExtPush = { type: "report"; view: View; forceShow: boolean };
