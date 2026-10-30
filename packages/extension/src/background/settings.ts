// Settings and the little durable state the extension keeps. Everything lives
// in this browser profile; nothing is ever written anywhere else.

import { normalizeAddress } from "../../../core/src/addresses.ts";
import { ARKIV_RPC, DEFAULT_TOR_GATEWAYS, DEFAULT_TRUSTED_ATTESTERS } from "../config.ts";
import type { Settings } from "../types.ts";

export const DEFAULT_SETTINGS: Settings = {
  network: "tor",
  torGateways: DEFAULT_TOR_GATEWAYS,
  // Measured 2026-10-30 (test/tor-isolation.mjs): the deployed tor-js worker
  // gives each isolationKey its own exit. Separate clients are then only
  // defence in depth, and each costs a ~7 s Tor bootstrap, so it's opt-in.
  strictIsolation: false,
  alerts: "modal",
  failOpen: false,
  disabledSites: [],
  hiddenSites: [],
  trustedAttesters: DEFAULT_TRUSTED_ATTESTERS,
  manualAddresses: [],
  arkivRpc: ARKIV_RPC,
};

const SETTINGS = "settings";
const ACCOUNTS = "accounts";
const SALT = "salt";

let settings: Settings | undefined;
let accounts: Set<string> | undefined;
let salt: Promise<string> | undefined;

// Storage is the source of truth: another context (a second popup, a test
// harness) may write it directly. Adopt new values rather than dropping the
// cache, so our own writes never leave a reader holding nothing.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (SETTINGS in changes) {
    const next = changes[SETTINGS].newValue as Partial<Settings> | undefined;
    settings = next ? { ...DEFAULT_SETTINGS, ...next } : undefined;
  }
  if (ACCOUNTS in changes) accounts = new Set((changes[ACCOUNTS].newValue as string[] | undefined) ?? []);
  if (SALT in changes) {
    const next = changes[SALT].newValue as string | undefined;
    salt = next ? Promise.resolve(next) : undefined;
  }
});

export async function getSettings(): Promise<Settings> {
  if (!settings) {
    const stored = (await chrome.storage.local.get(SETTINGS))[SETTINGS] as Partial<Settings> | undefined;
    settings = { ...DEFAULT_SETTINGS, ...stored };
  }
  return settings;
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  next.manualAddresses = next.manualAddresses.map(normalizeAddress).filter((a): a is string => a !== null);
  next.trustedAttesters = next.trustedAttesters.map(normalizeAddress).filter((a): a is string => a !== null);
  settings = next;
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

/** The user's own addresses: typed in, plus whatever their wallet reported. */
export async function ownAddresses(): Promise<Set<string>> {
  if (!accounts) {
    const stored = ((await chrome.storage.local.get(ACCOUNTS))[ACCOUNTS] as string[] | undefined) ?? [];
    accounts = new Set(stored);
  }
  return new Set([...accounts, ...(await getSettings()).manualAddresses]);
}

export async function learnAccounts(list: string[]): Promise<void> {
  await ownAddresses();
  const known = accounts ?? new Set<string>();
  const fresh = list.map(normalizeAddress).filter((a): a is string => a !== null && !known.has(a));
  if (fresh.length === 0) return;
  accounts = new Set([...known, ...fresh]);
  await chrome.storage.local.set({ [ACCOUNTS]: [...accounts] });
}

/**
 * Per-install salt for isolation keys. Wiping data rotates it. Memoised as a
 * promise: concurrent first calls must share one salt, or the same identity
 * would get two keys and two circuits.
 */
export function installSalt(): Promise<string> {
  return (salt ??= (async () => {
    let value = (await chrome.storage.local.get(SALT))[SALT] as string | undefined;
    if (!value) {
      value = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await chrome.storage.local.set({ [SALT]: value });
    }
    return value;
  })());
}

/** Forget everything but settings: learned accounts, caches, the salt, the modal log. */
export async function wipeLocalData(): Promise<void> {
  const keep = await getSettings();
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await chrome.storage.local.set({ [SETTINGS]: keep });
  accounts = undefined;
  salt = undefined;
}
