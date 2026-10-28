// Isolation keys: which calls may share a circuit.
//
// One key per *identity*, not per request. anon-rpc issue #10 measured the
// alternatives through tor-js: a key per address set gave failed calls and
// 60 s cold refreshes, while a key per account cost about the same as one
// shared circuit and still put five accounts on five exits.
//
// So the identity is the site, plus the user's own address when a call names
// one. Two sites never share a circuit, two accounts on one site never do, and
// calls that name nobody (block number, gas price) ride the site's circuit.

import { firstOwnAddress } from "./addresses.ts";
import type { JsonRpcRequest } from "./jsonrpc.ts";

export function isolationIdentity(site: string, request: JsonRpcRequest, own: ReadonlySet<string>): string {
  const address = firstOwnAddress(request.params, own);
  return address ? `${site}#${address}` : site;
}

/**
 * An opaque, per-install key for an identity. The worker sees every request
 * anyway, but it has no need to see site names or addresses in the key itself.
 * FNV-1a 64: not a security primitive, just data minimisation with a salt.
 */
export function opaqueKey(identity: string, salt: string): string {
  let hash = 0xcbf29ce484222325n;
  const input = new TextEncoder().encode(`${salt}\u0000${identity}`);
  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
