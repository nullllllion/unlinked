// The toolbar popup, also opened full-page as "Details" from the modal
// (popup.html?tab=<id>). The live part re-renders every second; the settings
// form is built once, so polling never steals focus from an input.

import { normalizeAddress } from "../../../core/src/addresses.ts";
import { NETWORKS } from "../config.ts";
import type { ExtRequest, NetworkId, Settings, StateReply, WorkerStatus } from "../types.ts";
import { el, markNode, rowNode } from "./render.ts";
import { STYLES } from "./styles.ts";
import { rowsFor } from "./view.ts";

const POPUP_STYLES = `
html, body { margin: 0; background: var(--u-bg); }
body { width: 360px; }
body.u-page { width: auto; max-width: 440px; margin: 40px auto; border: 1px solid var(--u-line); border-radius: 12px; overflow: hidden; }
.u-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border: 1px solid var(--u-line); border-radius: 999px; font-size: 12px; color: var(--u-muted); white-space: nowrap; }
.u-siteline { display: flex; align-items: center; gap: 10px; padding: 0 14px 10px; }
.u-sitename { flex: 1; min-width: 0; font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.u-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--u-muted); }
.u-switch { position: relative; flex: none; width: 30px; height: 18px; border-radius: 999px; background: var(--u-line); transition: background .15s; }
.u-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.u-switch[aria-checked="true"] { background: var(--u-good); }
.u-switch[aria-checked="true"]::after { transform: translateX(12px); }
.u-empty { padding: 4px 14px 18px; color: var(--u-muted); }
.u-settings { border-top: 1px solid var(--u-line); }
.u-settings > summary { padding: 10px 14px; cursor: pointer; color: var(--u-muted); list-style: none; user-select: none; }
.u-settings > summary::before { content: "▸"; display: inline-block; width: 14px; transition: transform .15s; }
.u-settings[open] > summary::before { transform: rotate(90deg); }
.u-field { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 8px; padding: 4px 14px; }
.u-field > span:first-child { color: var(--u-muted); font-size: 12px; }
.u-field select, .u-field input[type="text"], .u-field textarea { font: inherit; font-size: 12px; color: var(--u-fg); background: var(--u-bg);
  border: 1px solid var(--u-line); border-radius: 6px; padding: 4px 6px; width: 100%; }
.u-field textarea { font-family: var(--u-mono); resize: vertical; min-height: 44px; }
.u-hint { padding: 0 14px 4px 114px; font-size: 11.5px; color: var(--u-muted); }
.u-danger { margin: 8px 14px 14px; color: var(--u-bad); font-size: 12px; }
`;

const params = new URLSearchParams(location.search);
const pinnedTab = params.has("tab") ? Number(params.get("tab")) : undefined;
const expanded = new Set<string>();
let tabId: number | undefined;
let last: StateReply | undefined;

const ask = <T = unknown>(msg: ExtRequest) => chrome.runtime.sendMessage(msg) as Promise<T>;

document.head.append(el("style", {}, STYLES + POPUP_STYLES));
document.body.classList.add("u");
if (pinnedTab !== undefined) document.body.classList.add("u-page");
const live = el("div");
const settingsForm = el("details", { class: "u-settings" });
document.body.append(live, settingsForm);

function statusPill(status: WorkerStatus): HTMLElement {
  const label = NETWORKS[status.network].label;
  const tone = { idle: "neutral", booting: "pending", ready: NETWORKS[status.network].private ? "good" : "warn", error: "bad" }[status.state];
  const text = { idle: `${label} idle`, booting: `${label} starting`, ready: `${label} ready`, error: `${label} down` }[status.state];
  return el("span", { class: "u-pill", title: status.error ?? "" }, el("span", { class: "u-dot", "data-tone": tone }), text);
}

function render(s: StateReply): void {
  last = s;
  const head = el("header", { class: "u-head" }, markNode(), el("span", { class: "u-brand" }, "Unlinked"), el("span", { class: "u-spacer" }), statusPill(s.status));
  if (!s.view || !s.view.report.site) {
    live.replaceChildren(head, el("p", { class: "u-empty" }, "Open a dapp to see what it leaks, check its code and protect its reads."));
    return;
  }
  const { report } = s.view;
  const on = !s.settings.disabledSites.includes(report.site);
  const sw = el("button", { class: "u-switch", role: "switch", "aria-checked": String(on), "aria-label": `Protect ${report.site}` });
  sw.addEventListener("click", () => {
    const disabledSites = on ? [...s.settings.disabledSites, report.site] : s.settings.disabledSites.filter((x) => x !== report.site);
    void ask<StateReply>({ type: "settings", patch: { disabledSites } }).then(refresh);
  });
  const rows = rowsFor(s.view).map((row) =>
    rowNode(row, {
      expandable: true,
      open: expanded.has(row.id),
      onToggle: () => {
        if (!expanded.delete(row.id)) expanded.add(row.id);
        if (last) render(last);
      },
    }),
  );
  live.replaceChildren(
    head,
    el("div", { class: "u-siteline" }, el("span", { class: "u-sitename", title: report.url }, report.site), el("label", { class: "u-toggle" }, on ? "Protected" : "Off", sw)),
    el("ul", { class: "u-rows" }, ...rows),
  );
  syncSettings(s.settings);
}

/* --- settings: built once, values synced when not being edited ----------- */

const network = el("select", { "aria-label": "Anonymity network" }, ...(Object.keys(NETWORKS) as NetworkId[]).map((id) =>
  el("option", { value: id }, NETWORKS[id].private ? NETWORKS[id].label : `${NETWORKS[id].label} (not private)`),
));
const strict = el("input", { type: "checkbox", "aria-label": "Strict isolation" });
const alerts = el("select", { "aria-label": "Alerts" }, el("option", { value: "modal" }, "Summary on dapps"), el("option", { value: "badge" }, "Badge only"));
const failOpen = el("input", { type: "checkbox", "aria-label": "Fail open" });
const addresses = el("textarea", { rows: "2", spellcheck: "false", placeholder: "0x… one per line", "aria-label": "Your addresses" });
const attesters = el("textarea", { rows: "2", spellcheck: "false", placeholder: "0x… one per line (none: nothing shows as verified)", "aria-label": "Trusted attesters" });
const wipe = el("button", { class: "u-danger" }, "Wipe local data");

const field = (label: string, control: HTMLElement) => el("label", { class: "u-field" }, el("span", {}, label), control);
settingsForm.append(
  el("summary", {}, "Settings"),
  field("Network", network),
  field("Isolation", el("span", { class: "u-toggle" }, strict, "One client per identity")),
  field("Alerts", alerts),
  field("If down", el("span", { class: "u-toggle" }, failOpen, "Send directly (less private)")),
  field("Addresses", addresses),
  el("p", { class: "u-hint" }, "Learned from your wallet automatically; add others to isolate and track them."),
  field("Attesters", attesters),
  wipe,
);

const patch = (p: Partial<Settings>) => void ask<StateReply>({ type: "settings", patch: p }).then(render);
network.addEventListener("change", () => patch({ network: network.value as NetworkId }));
strict.addEventListener("change", () => patch({ strictIsolation: strict.checked }));
alerts.addEventListener("change", () => patch({ alerts: alerts.value as Settings["alerts"] }));
failOpen.addEventListener("change", () => patch({ failOpen: failOpen.checked }));
const lines = (t: HTMLTextAreaElement) => t.value.split(/[\s,]+/).map(normalizeAddress).filter((a): a is string => a !== null);
addresses.addEventListener("change", () => patch({ manualAddresses: lines(addresses) }));
attesters.addEventListener("change", () => patch({ trustedAttesters: lines(attesters) }));
wipe.addEventListener("click", () => {
  if (confirm("Forget learned addresses, caches and per-site history? Settings are kept.")) void ask<StateReply>({ type: "wipe" }).then(render);
});

function syncSettings(s: Settings): void {
  const idle = (n: Element) => document.activeElement !== n;
  if (idle(network)) network.value = s.network;
  if (idle(strict)) strict.checked = s.strictIsolation;
  if (idle(alerts)) alerts.value = s.alerts;
  if (idle(failOpen)) failOpen.checked = s.failOpen;
  if (idle(addresses)) addresses.value = s.manualAddresses.join("\n");
  if (idle(attesters)) attesters.value = s.trustedAttesters.join("\n");
}

async function refresh(): Promise<void> {
  const s = await ask<StateReply | undefined>({ type: "state", tabId }).catch(() => undefined);
  if (s) render(s);
}

void (async () => {
  tabId = pinnedTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  await refresh();
  setInterval(refresh, 1_000);
})();
