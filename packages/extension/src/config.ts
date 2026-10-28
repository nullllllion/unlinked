// Everything an operator might want to change, in one place.

import type { NetworkId } from "./types.ts";

export type Network = {
  label: string;
  /** The IWorkerSpecifier contract that pins the worker bundle's hash. */
  specifier: string;
  /** The chain the specifier lives on: where the one bootstrap read goes. */
  specifierChainId: number;
  private: boolean;
};

// From ethereum/anon-rpc adopters.json5 (spec 0.4.0).
export const NETWORKS: Readonly<Record<NetworkId, Network>> = {
  tor: { label: "Tor", specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e", specifierChainId: 1, private: true },
  nym: { label: "Nym", specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0", specifierChainId: 1, private: true },
  passthrough: {
    label: "Passthrough",
    specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    specifierChainId: 1,
    private: false,
  },
};

/**
 * tor-js reaches Tor through KPS gateways, because browsers can't open raw TCP.
 * This is the EF demo gateway: limited capacity, may disappear. Run your own.
 */
export const DEFAULT_TOR_GATEWAYS = ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"];

/** Used once per install to read a specifier, then refreshed through the worker itself. */
export const BOOTSTRAP_RPC: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};

/** Where to retry when a dapp's own RPC refuses anonymized traffic. */
export const FALLBACK_RPCS: Readonly<Record<string, string[]>> = {
  "0x1": ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  "0xaa36a7": ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
  "0xa": ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  "0x2105": ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
  "0xa4b1": ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
};

export const ARKIV_RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";

/**
 * Wallets whose attestations count by default. Fill in your CI attester and
 * an independent rebuilder before shipping; empty means "accept any owner",
 * which is only useful while developing.
 */
export const DEFAULT_TRUSTED_ATTESTERS: string[] = [];

/** Strict isolation boots up to this many independent anon clients. */
export const POOL_SIZE = 3;

/**
 * Headers every anonymized request carries, identical for every user.
 * Arkiv's RPC sits behind Cloudflare and rejects unusual user agents
 * (measured: python-urllib gets 403), so a neutral one is sent rather than
 * whatever a worker's HTTP stack would default to.
 */
export const WIRE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0",
};

/** Upper bound on the random delay before each anonymized request, in ms. */
export const MAX_JITTER_MS = 120;

export const BOOT_TIMEOUT_MS = 120_000;
export const CALL_TIMEOUT_MS = 60_000;
