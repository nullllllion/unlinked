// The single view model behind the modal, the popup and the badge, so the
// three can never disagree about a site.

import { NETWORKS } from "../config.ts";
import type { View } from "../types.ts";

export type Tone = "good" | "warn" | "bad" | "neutral" | "pending";
export type RowId = "rpc" | "trackers" | "metadata" | "code" | "worker";
export type Row = { id: RowId; label: string; tone: Tone; text: string; sub?: string; details: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex);
const repoName = (repo: string) => repo.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");

export function rowsFor(view: View): Row[] {
  return [rpcRow(view), trackersRow(view), metadataRow(view), codeRow(view), workerRow(view)];
}

function rpcRow({ report, settings }: View): Row {
  const { rpc } = report;
  const network = NETWORKS[settings.network];
  const on = !settings.disabledSites.includes(report.site);
  const providers = Object.entries(rpc.providers).sort((a, b) => b[1] - a[1]);
  const details = [
    ...providers.map(([host, n]) => `${host} · ${plural(n, "call")}`),
    `${plural(rpc.withAddress, "call")} named your address`,
    `${plural(rpc.cached, "answer")} served from cache`,
  ];
  if (rpc.latencyCount) details.push(`${Math.round(rpc.latencyTotal / rpc.latencyCount)} ms average round trip`);
  if (rpc.failovers) details.push(`${plural(rpc.failovers, "failover")} to a provider that accepts anonymous traffic`);
  if (rpc.walletReads) details.push(`${plural(rpc.walletReads, "read")} went through your wallet's own RPC (not reroutable)`);
  for (const ws of rpc.websockets) details.push(`WebSocket to ${ws} (not covered)`);

  if (rpc.calls === 0) {
    return {
      id: "rpc",
      label: "RPC",
      tone: "neutral",
      text: "No RPC calls yet",
      sub: on ? `Reads will go through ${network.label}` : "Protection is off for this site",
      details,
    };
  }
  const covered = rpc.routed + rpc.cached;
  const pct = Math.round((covered / rpc.calls) * 100);
  details.unshift(`${plural(rpc.keys.length, "unlinked circuit")}: one per site, and per account where a call names one`);
  const notes: string[] = [];
  if (!on) notes.push("protection off for this site");
  else notes.push(`${pct}% via ${network.label}`, plural(rpc.keys.length, "circuit"));
  if (rpc.failed) notes.push(`${rpc.failed} failed`);
  const good = on && network.private && pct === 100 && rpc.failed === 0;
  return {
    id: "rpc",
    label: "RPC",
    tone: good ? "good" : "warn",
    text: `${plural(rpc.calls, "call")} → ${plural(providers.length, "provider")}`,
    sub: (good ? "✓ " : "") + notes.join(" · "),
    details,
  };
}

function trackersRow({ report }: View): Row {
  const parties = Object.values(report.thirdParties).sort(
    (a, b) => Number(b.gotAddress) - Number(a.gotAddress) || Number(!!b.category) - Number(!!a.category) || b.requests - a.requests,
  );
  const named = parties.filter((p) => p.category);
  const leaked = parties.filter((p) => p.gotAddress);
  const details = parties.map(
    (p) => `${p.host}${p.category ? ` · ${p.category}` : ""} · ${plural(p.requests, "request")}${p.gotAddress ? " · got your address" : ""}`,
  );
  if (parties.length === 0) {
    return { id: "trackers", label: "Trackers", tone: "good", text: "No third parties contacted", details };
  }
  const text =
    plural(parties.length, "third party", "third parties") + (named.length ? ` · ${plural(named.length, "tracker")}` : "");
  let sub = "None received your address";
  if (leaked.length) sub = `${leaked[0].host}${leaked.length > 1 ? ` +${leaked.length - 1}` : ""} got your address`;
  else if (named.length) sub = named.slice(0, 2).map((p) => p.host).join(", ");
  return { id: "trackers", label: "Trackers", tone: leaked.length || named.length ? "warn" : "neutral", text, sub, details };
}

function metadataRow({ report }: View): Row {
  const { fingerprint, refererLeaks, thirdPartyCookies } = report.meta;
  const signals: string[] = [];
  if (fingerprint.canvas) signals.push("canvas readback");
  if (fingerprint.webgl) signals.push("GPU fingerprint");
  if (fingerprint.audio) signals.push("audio fingerprint");
  if (refererLeaks.length) signals.push("address in Referer");
  if (thirdPartyCookies) signals.push(plural(thirdPartyCookies, "third-party cookie"));
  const details = [
    ...Object.entries(fingerprint).map(([api, n]) => `${api}: ${plural(n, "call")} (counted in the page, best-effort)`),
    ...refererLeaks.map((h) => `Referer with your address sent to ${h}`),
  ];
  if (signals.length === 0) return { id: "metadata", label: "Metadata", tone: "good", text: "Nothing notable", details };
  return {
    id: "metadata",
    label: "Metadata",
    tone: "warn",
    text: signals.slice(0, 2).join(" · "),
    sub: signals.length > 2 ? `+${signals.length - 2} more` : undefined,
    details,
  };
}

function codeRow({ report, settings }: View): Row {
  const v = report.code;
  const label = "Code";
  if (!report.dapp) return { id: "code", label, tone: "neutral", text: "Checked on dapps only", details: [] };
  switch (v.state) {
    case "pending":
      return { id: "code", label, tone: "pending", text: "Checking Arkiv…", sub: `Lookup goes through ${NETWORKS[settings.network].label}`, details: [] };
    case "none":
      return { id: "code", label, tone: "neutral", text: "No scripts to check", details: [] };
    case "error":
      return { id: "code", label, tone: "neutral", text: "Couldn't reach Arkiv", sub: v.message, details: [] };
    case "unattested":
      return {
        id: "code",
        label,
        tone: "neutral",
        text: "No public attestation",
        sub: "Can't confirm this matches a public repo",
        details: [`${plural(v.checked, "file")} checked`, ...(v.unreadable ? [`${plural(v.unreadable, "file")} unreadable (cross-origin)`] : [])],
      };
    case "verified": {
      // Arkiv is permissionless: anyone can attest any build under any repo
      // name. Without a list of wallets the user trusts, a match proves
      // nothing, so it must never look like a green check.
      const vetted = settings.trustedAttesters.length > 0;
      return {
        id: "code",
        label,
        tone: vetted ? "good" : "warn",
        text: vetted ? `✓ ${repoName(v.build.repo)} @${v.build.commit.slice(0, 7)}` : `Attested by unvetted wallets`,
        sub: vetted
          ? `${plural(v.build.attesters.length, "attester")} on Arkiv · ${plural(v.build.expiresInDays, "day")} left`
          : `Claims ${repoName(v.build.repo)} @${v.build.commit.slice(0, 7)} · add trusted attesters in Settings`,
        details: [
          `${plural(v.checked, "file")} match build ${short(v.build.root)}`,
          ...(v.build.version ? [`version ${v.build.version}`] : []),
          ...v.build.attesters.map((a) => `attested by ${a}`),
          ...(v.unreadable ? [`${plural(v.unreadable, "file")} unreadable (cross-origin), not checked`] : []),
        ],
      };
    }
    case "mismatch":
      return {
        id: "code",
        label,
        tone: "bad",
        text: "✗ Not the attested build",
        sub: v.build
          ? `${plural(v.unknown.length, "file")} not in ${repoName(v.build.repo)} @${v.build.commit.slice(0, 7)}`
          : `${plural(v.unknown.length, "file")} not in any attested build`,
        details: v.unknown.map((u) => `not attested: ${u}`),
      };
  }
}

function workerRow({ status, settings }: View): Row {
  const network = NETWORKS[status.network];
  const details = [`specifier ${status.specifier}`];
  if (status.pinnedHash) details.push(`bundle keccak ${status.pinnedHash}`);
  if (status.bootMs !== undefined) details.push(`booted in ${(status.bootMs / 1000).toFixed(1)} s`);
  if (status.bootstrapCached) details.push("specifier read from this install's cache (no fresh non-anonymous read)");
  if (status.slots) details.push(`${plural(status.slots, "independent client")} running`);

  switch (status.state) {
    case "idle":
      return { id: "worker", label: "Worker", tone: "neutral", text: `${network.label} starts on first call`, details };
    case "booting":
      return { id: "worker", label: "Worker", tone: "pending", text: `Starting ${network.label}…`, sub: "Calls wait; none are sent directly", details };
    case "error":
      return {
        id: "worker",
        label: "Worker",
        tone: "bad",
        text: "Anonymity network unavailable",
        sub: settings.failOpen ? "Fail-open: sending directly" : "Calls are blocked, not leaked",
        details: [status.error ?? "unknown error", ...details],
      };
    case "ready":
      return network.private
        ? {
            id: "worker",
            label: "Worker",
            tone: "good",
            text: `${network.label} worker verified`,
            sub: status.pinnedHash ? `keccak ${short(status.pinnedHash)} pinned on‑chain` : "Hash-pinned on‑chain",
            details,
          }
        : { id: "worker", label: "Worker", tone: "warn", text: "Passthrough worker: not private", sub: "Development only", details };
  }
}

export function overallTone(rows: Row[]): Tone {
  if (rows.some((r) => r.tone === "bad")) return "bad";
  if (rows.some((r) => r.tone === "warn")) return "warn";
  if (rows.some((r) => r.tone === "good")) return "good";
  return rows.some((r) => r.tone === "pending") ? "pending" : "neutral";
}

export function issueCount(rows: Row[]): number {
  return rows.filter((r) => r.tone === "warn" || r.tone === "bad").length;
}
