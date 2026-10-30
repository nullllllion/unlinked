// DOM helpers shared by the modal and the popup. Every string reaching the DOM
// goes through textContent: hostnames, repo names and file URLs come from the
// network and from Arkiv, and none of them are trusted.

import type { Row } from "./view.ts";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

/** A row; with `expandable`, clicking it toggles its details list. */
export function rowNode(row: Row, opts: { expandable?: boolean; open?: boolean; onToggle?: () => void } = {}): HTMLElement {
  const li = el("li", { class: "u-row", "data-tone": row.tone, "data-row": row.id });
  li.append(
    el("span", { class: "u-label" }, row.label),
    el("span", { class: "u-main" }, el("span", { class: "u-dot", "data-tone": row.tone }), el("span", { class: "u-text", title: row.text }, row.text)),
  );
  if (row.sub) li.append(el("span", { class: "u-sub", title: row.sub }, row.sub));
  if (opts.expandable && row.details.length) {
    li.style.cursor = "pointer";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-expanded", String(!!opts.open));
    const toggle = () => opts.onToggle?.();
    li.addEventListener("click", toggle);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    if (opts.open) li.append(el("ul", { class: "u-details" }, ...row.details.map((d) => el("li", {}, d))));
  }
  return li;
}

/** The mark: a ring with its left half filled. Built with DOM calls, so no innerHTML anywhere (Trusted Types pages included). */
export function markNode(): HTMLElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const ring = document.createElementNS(NS, "circle");
  for (const [k, v] of Object.entries({ cx: "8", cy: "8", r: "6.25", fill: "none", stroke: "currentColor", "stroke-width": "1.5" })) ring.setAttribute(k, v);
  const half = document.createElementNS(NS, "path");
  half.setAttribute("d", "M8 1.75a6.25 6.25 0 0 0 0 12.5z");
  half.setAttribute("fill", "currentColor");
  svg.append(ring, half);
  return el("span", { class: "u-mark" }, svg);
}
