import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsByHashQuery, buildsByRootQuery, parseArkivPage, type ArkivEntity } from "../src/arkiv.ts";
import { canonicalManifest, hashableBytes, manifestRoot, sha256Hex } from "../src/manifest.ts";
import { computeVerdict } from "../src/verdict.ts";

const h = (c: string) => "0x" + c.repeat(64);
const CI = "0x00000000000000000000000000000000000000c1";
const LAPTOP = "0x00000000000000000000000000000000000000c2";
const STRANGER = "0x00000000000000000000000000000000000000ff";
const ROOT = h("a");

const asset = (sha: string, owner = CI, root = ROOT): ArkivEntity => ({
  key: "0x" + sha.slice(2, 10),
  owner,
  expiresAt: 0n,
  attributes: { project: "unlinked", type: "asset", sha256: sha, root },
});
const build = (owner: string, expiresAt: bigint): ArkivEntity => ({
  key: "0xb" + owner.slice(-2),
  owner,
  expiresAt,
  attributes: { type: "build", root: ROOT, name: "quiet-swap", repo: "github.com/you/quiet-swap", commit: "a1b2c3d", version: "0.1.0" },
});

const page = [
  { url: "https://q.example/assets/index.js", sha256: h("1") },
  { url: "https://q.example/assets/index.css", sha256: h("2") },
];
const builds = [build(CI, 1_000_000n), build(LAPTOP, 2_000_000n)];
const head = 1_000_000n - 43_200n * 27n; // 27 days of 2 s blocks before the earliest expiry

test("every asset under one trusted root is verified, with both attesters and the earliest expiry", () => {
  const v = computeVerdict({
    assets: page,
    assetEntities: [asset(h("1")), asset(h("2")), asset(h("1"), LAPTOP), asset(h("2"), LAPTOP)],
    buildEntities: builds,
    trusted: new Set([CI, LAPTOP]),
    headBlock: head,
  });
  assert.equal(v.state, "verified");
  if (v.state !== "verified") return;
  assert.deepEqual(v.build.attesters, [CI, LAPTOP]);
  assert.equal(v.build.expiresInDays, 27);
  assert.equal(v.build.commit, "a1b2c3d");
});

test("one injected script next to genuine ones is a mismatch, naming the stranger file", () => {
  const injected = { url: "https://q.example/assets/drainer.js", sha256: h("9") };
  const v = computeVerdict({
    assets: [...page, injected],
    assetEntities: [asset(h("1")), asset(h("2"))],
    buildEntities: builds,
    trusted: new Set([CI]),
    headBlock: head,
  });
  assert.equal(v.state, "mismatch");
  if (v.state === "mismatch") assert.deepEqual(v.unknown, [injected.url]);
});

test("attestations from untrusted owners count for nothing", () => {
  const v = computeVerdict({
    assets: page,
    assetEntities: [asset(h("1"), STRANGER), asset(h("2"), STRANGER)],
    buildEntities: [build(STRANGER, 5n)],
    trusted: new Set([CI]),
    headBlock: 0n,
  });
  assert.equal(v.state, "unattested");
});

test("no assets, or only unreadable ones, are reported as such", () => {
  const base = { assetEntities: [], buildEntities: [], trusted: new Set<string>(), headBlock: 0n };
  assert.equal(computeVerdict({ ...base, assets: [] }).state, "none");
  const v = computeVerdict({ ...base, assets: [{ url: "https://cdn.example/x.js", sha256: null }] });
  assert.deepEqual(v, { state: "unattested", checked: 0, unreadable: 1 });
});

test("queries batch every hash into one OR, so a page costs one round trip", () => {
  const q = assetsByHashQuery([h("1"), h("2")]);
  assert.equal(q, `project = str('unlinked') AND type = str('asset') AND (sha256 = bytes32(${h("1")}) OR sha256 = bytes32(${h("2")}))`);
  assert.match(buildsByRootQuery([ROOT]), /type = str\('build'\) AND \(root = bytes32\(0xa{64}\)\)$/);
  assert.throws(() => assetsByHashQuery(["0x12"]), /not a bytes32/);
  assert.throws(() => assetsByHashQuery(["') OR (1 = 1"]), /not a bytes32/);
});

test("parseArkivPage reads the live Tiramisu response shape", () => {
  // Captured from rpc.tiramisu.db-chain.testnet.arkiv.network on 2026-10-28.
  const live = {
    data: [
      {
        key: "0xA5ae1b2df5b09898c7fca946903e74095e57347d8581a614075ae22de1743d30",
        owner: "0x679b5ab1cd4b488d73025d0d72d4017fa2d97b59",
        expiresAt: "0x11cd45",
        attributes: [
          { name: "project", type: "str", value: "arkiv-chain-indexer-baseload" },
          { name: "random_number_0", type: "u64", value: "0xE2d64ed3bc11" },
        ],
      },
    ],
    blockNumber: "0x11c9c2",
    cursor: "b64:4WL0wsClOGgAAAAAABh_cQ",
  };
  const p = parseArkivPage(live);
  assert.equal(p.blockNumber, 0x11c9c2n);
  assert.equal(p.entities[0].expiresAt, 0x11cd45n);
  assert.equal(p.entities[0].key, "0xa5ae1b2df5b09898c7fca946903e74095e57347d8581a614075ae22de1743d30");
  assert.equal(p.entities[0].attributes.random_number_0, "0xe2d64ed3bc11");
  assert.equal(p.cursor, "b64:4WL0wsClOGgAAAAAABh_cQ");
});

test("manifest roots are order-independent and store-added manifest keys are ignored", async () => {
  assert.equal(canonicalManifest({ b: "2", a: "1" }), '{"a":"1","b":"2"}');
  assert.equal(await manifestRoot({ b: "2", a: "1" }), await manifestRoot({ a: "1", b: "2" }));
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  const built = new TextEncoder().encode(JSON.stringify({ name: "Unlinked", version: "0.1.0" }));
  const fromStore = new TextEncoder().encode(JSON.stringify({ name: "Unlinked", version: "0.1.0", update_url: "https://store/x" }));
  assert.deepEqual(hashableBytes("manifest.json", fromStore), hashableBytes("manifest.json", built));
  assert.deepEqual(hashableBytes("app.js", fromStore), fromStore, "only manifest.json is canonicalised");
});
