// The short in-page summary, in a closed shadow root so the page can't read or
// restyle it. A page can still detect the host element, and could draw a fake
// card of its own — which is why the toolbar badge, not this card, is the
// authoritative signal, and why this card never asks for anything.

import type { View } from "../types.ts";
import { el, markNode, rowNode } from "./render.ts";
import { MODAL_STYLES, STYLES } from "./styles.ts";
import { overallTone, rowsFor } from "./view.ts";

const AUTO_CLOSE_MS = 10_000;

export type ModalActions = { details(): void; hide(): void };

export class Modal {
  #host: HTMLElement | null = null;
  #card: HTMLElement | null = null;
  #timer = 0;
  #hovered = false;
  readonly #actions: ModalActions;

  constructor(actions: ModalActions) {
    this.#actions = actions;
  }

  get open(): boolean {
    return this.#host !== null;
  }

  show(view: View): void {
    if (!this.#host) {
      this.#host = document.createElement("unlinked-summary");
      const root = this.#host.attachShadow({ mode: "closed" });
      root.append(el("style", {}, STYLES + MODAL_STYLES));
      this.#card = el("section", { class: "u u-card", role: "region", "aria-label": "Unlinked privacy summary" });
      this.#card.addEventListener("mouseenter", () => (this.#hovered = true));
      this.#card.addEventListener("mouseleave", () => {
        this.#hovered = false;
        this.#schedule();
      });
      root.append(this.#card);
      document.documentElement.append(this.#host);
      window.addEventListener("keydown", this.#onKey, true);
    }
    this.update(view);
  }

  update(view: View): void {
    if (!this.#card) return;
    const rows = rowsFor(view);
    const tone = overallTone(rows);
    this.#card.dataset.tone = tone;

    const close = el("button", { class: "u-x", "aria-label": "Close" }, "×");
    close.addEventListener("click", () => this.close());
    const details = el("button", { class: "u-link" }, "Details");
    details.addEventListener("click", () => this.#actions.details());
    const hide = el("button", { class: "u-link u-quiet" }, "Don't show on this site");
    hide.addEventListener("click", () => {
      this.#actions.hide();
      this.close();
    });

    this.#card.replaceChildren(
      el("header", { class: "u-head" }, markNode(), el("span", { class: "u-brand" }, "Unlinked"), el("span", { class: "u-site" }, `· ${view.report.site}`), el("span", { class: "u-spacer" }), close),
      el("ul", { class: "u-rows" }, ...rows.map((r) => rowNode(r))),
      el("footer", { class: "u-foot" }, details, el("span", { class: "u-spacer" }), hide),
    );
    this.#schedule();
  }

  close(): void {
    clearTimeout(this.#timer);
    window.removeEventListener("keydown", this.#onKey, true);
    this.#host?.remove();
    this.#host = null;
    this.#card = null;
  }

  /** Good news goes away on its own; a code mismatch stays until dismissed. */
  #schedule(): void {
    clearTimeout(this.#timer);
    if (this.#card?.dataset.tone === "bad") return;
    this.#timer = window.setTimeout(() => {
      if (this.#hovered) this.#schedule();
      else this.close();
    }, AUTO_CLOSE_MS);
  }

  #onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open) this.close();
  };
}
