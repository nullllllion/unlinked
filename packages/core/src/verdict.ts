// Does the code this page loaded match a build someone vouched for?
//
// Each asset record ties a file hash to a build root. A page is "verified"
// when one root covers every readable asset and a trusted attester published
// that root. When some assets match a root and others match nothing, that is
// the shape of a hijacked frontend — an injected or swapped script alongside
// the real ones — and it is the one case reported as bad.

import { ARKIV_BLOCK_SECONDS, type ArkivEntity } from "./arkiv.ts";

export type AssetHash = { url: string; sha256: string | null };

export type BuildInfo = {
  root: string;
  name: string;
  repo: string;
  commit: string;
  version: string;
  attesters: string[];
  expiresInDays: number;
};

export type CodeVerdict =
  | { state: "pending" }
  | { state: "none" }
  | { state: "error"; message: string }
  | { state: "unattested"; checked: number; unreadable: number }
  | { state: "verified"; build: BuildInfo; checked: number; unreadable: number }
  | { state: "mismatch"; build: BuildInfo | null; unknown: string[]; checked: number; unreadable: number };

export type VerdictInput = {
  assets: AssetHash[];
  assetEntities: ArkivEntity[];
  buildEntities: ArkivEntity[];
  /** Lowercase owner addresses to accept. Empty means accept any owner. */
  trusted: ReadonlySet<string>;
  headBlock: bigint;
};

export function computeVerdict(input: VerdictInput): CodeVerdict {
  const { assets, trusted } = input;
  const accept = (owner: string) => trusted.size === 0 || trusted.has(owner);
  const readable = assets.filter((a): a is { url: string; sha256: string } => a.sha256 !== null);
  const unreadable = assets.length - readable.length;
  if (readable.length === 0) return assets.length === 0 ? { state: "none" } : { state: "unattested", checked: 0, unreadable };

  // file hash -> roots that include it, from trusted attesters only
  const rootsByHash = new Map<string, Set<string>>();
  for (const e of input.assetEntities) {
    if (!accept(e.owner)) continue;
    const sha = String(e.attributes.sha256 ?? "");
    const root = String(e.attributes.root ?? "");
    if (!sha || !root) continue;
    let roots = rootsByHash.get(sha);
    if (!roots) rootsByHash.set(sha, (roots = new Set()));
    roots.add(root);
  }

  const covered = (root: string) => readable.filter((a) => rootsByHash.get(a.sha256)?.has(root)).length;
  const candidates = new Set<string>();
  for (const roots of rootsByHash.values()) for (const r of roots) candidates.add(r);
  if (candidates.size === 0) return { state: "unattested", checked: readable.length, unreadable };

  const ranked = [...candidates]
    .map((root) => ({ root, covered: covered(root), build: describeBuild(root, input) }))
    .sort((a, b) => b.covered - a.covered || (b.build?.attesters.length ?? 0) - (a.build?.attesters.length ?? 0));
  const best = ranked[0];

  if (best.covered === readable.length && best.build && best.build.attesters.length > 0) {
    return { state: "verified", build: best.build, checked: readable.length, unreadable };
  }
  const unknown = readable.filter((a) => !rootsByHash.get(a.sha256)?.has(best.root)).map((a) => a.url);
  return { state: "mismatch", build: best.build, unknown, checked: readable.length, unreadable };
}

function describeBuild(root: string, input: VerdictInput): BuildInfo | null {
  const accept = (owner: string) => input.trusted.size === 0 || input.trusted.has(owner);
  const builds = input.buildEntities.filter((e) => e.attributes.root === root && accept(e.owner));
  if (builds.length === 0) return null;
  const first = builds[0].attributes;
  const soonest = builds.reduce((min, e) => (e.expiresAt < min ? e.expiresAt : min), builds[0].expiresAt);
  const blocksLeft = soonest > input.headBlock ? soonest - input.headBlock : 0n;
  return {
    root,
    name: String(first.name ?? ""),
    repo: String(first.repo ?? ""),
    commit: String(first.commit ?? ""),
    version: String(first.version ?? ""),
    attesters: [...new Set(builds.map((e) => e.owner))].sort(),
    expiresInDays: Math.floor((Number(blocksLeft) * ARKIV_BLOCK_SECONDS) / 86_400),
  };
}
