#!/usr/bin/env node
// Publish a build attestation on Arkiv: one `build` entity carrying the full
// manifest, plus one `asset` entity per code file so a browser can look up a
// single script by its hash. All in one atomic batch, all owned by the
// attester's wallet: only that wallet can extend, change or delete them.
//
//   PRIVATE_KEY=0x… node packages/attest/src/attest.ts \
//     --dir packages/quiet-swap/dist --kind frontend --name quiet-swap \
//     --repo github.com/you/unlinked --commit "$(git rev-parse HEAD)" --version 0.1.0
//
// Run it from two machines with two wallets on the same commit: matching roots
// from independent rebuilds are what "2 attesters" means in the extension.
// --dry-run prints everything without a key or a transaction.

import { parseArgs } from "node:util";
import { createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { bytes32, str } from "@arkiv-network/sdk/attr";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARKIV_PROJECT } from "../../core/src/arkiv.ts";
import { isCodeAsset } from "../../core/src/manifest.ts";
import { readBuild } from "./build-files.ts";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    kind: { type: "string", default: "frontend" },
    name: { type: "string" },
    repo: { type: "string" },
    commit: { type: "string" },
    version: { type: "string", default: "" },
    domain: { type: "string", default: "" },
    swarm: { type: "string", default: "" },
    days: { type: "string", default: "30" },
    "dry-run": { type: "boolean", default: false },
  },
});

for (const required of ["dir", "name", "repo", "commit"] as const) {
  if (!args[required]) fail(`--${required} is required`);
}
if (args.kind !== "frontend" && args.kind !== "extension") fail("--kind must be frontend or extension");

const MAX_STR = 128; // Arkiv's limit for a string attribute, in bytes
const clip = (s: string) => (Buffer.byteLength(s) <= MAX_STR ? s : Buffer.from(s).subarray(0, MAX_STR).toString("utf8").replace(/�$/, ""));

const build = await readBuild(args.dir!);
const codeFiles = Object.entries(build.files).filter(([path]) => isCodeAsset(path)).sort(([a], [b]) => a.localeCompare(b));
const days = Number(args.days);

const buildAttributes = {
  project: ARKIV_PROJECT,
  type: "build",
  kind: str(args.kind!),
  name: str(clip(args.name!)),
  repo: str(clip(args.repo!)),
  commit: str(clip(args.commit!)),
  version: str(clip(args.version!)),
  root: bytes32(build.root as `0x${string}`),
  ...(args.domain ? { domain: str(clip(args.domain)) } : {}),
  ...(args.swarm ? { swarm: str(clip(args.swarm)) } : {}),
};

console.log(`build ${args.name} @ ${args.commit!.slice(0, 12)}  root ${build.root}`);
console.log(`${Object.keys(build.files).length} files, ${codeFiles.length} code assets, expiring in ${days} days`);
for (const [path, hash] of codeFiles) console.log(`  ${hash}  ${path}`);

if (args["dry-run"]) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}

const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!key) fail("set PRIVATE_KEY to the attester wallet's key (fund it with GLM from hub.arkiv.network/faucet)");

const account = privateKeyToAccount(key);
const client = createWalletClient({ chain: tiramisu, transport: http(), account });
const expires = ExpirationTime.fromDays(days);

const { txHash, createdEntities } = await client.executeBatch({ creates: entities() }).catch((err: unknown) => {
  // An unfunded wallet surfaces as "Execution error without revert data …
  // gas required exceeds: 0", which says nothing about money. Say it plainly.
  let chain = "";
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) chain += `${(e as Error).message ?? e}\n`;
  if (/gas required exceeds: 0\b/.test(chain)) {
    fail(`${account.address} has no GLM for gas: get test GLM at https://hub.arkiv.network/faucet`);
  }
  throw err;
});

console.log(`\nattested by ${account.address.toLowerCase()}`);
console.log(`tx       ${txHash}`);
console.log(`build    ${createdEntities[0]}`);
console.log(`assets   ${createdEntities.length - 1}`);
console.log(`\nquery:   project = str('${ARKIV_PROJECT}') AND type = str('build') AND root = bytes32(${build.root})`);

function entities() {
  return [
    { payload: jsonToPayload({ ...build, name: args.name, repo: args.repo, commit: args.commit }), contentType: "application/json", attributes: buildAttributes, expires },
    ...codeFiles.map(([path, hash]) => ({
      payload: new Uint8Array(),
      contentType: "application/octet-stream",
      attributes: {
        project: ARKIV_PROJECT,
        type: "asset",
        sha256: bytes32(hash as `0x${string}`),
        root: bytes32(build.root as `0x${string}`),
        path: str(clip(path)),
      },
      expires,
    })),
  ];
}

function fail(message: string): never {
  console.error(`attest: ${message}`);
  process.exit(2);
}
