// Design tokens and components for every Unlinked surface. The modal injects
// this into its shadow root; the popup into a <style> tag.

export const STYLES = `
:host, :root {
  --u-bg: #ffffff; --u-fg: #1f2328; --u-muted: #59636e; --u-line: #d1d9e0; --u-soft: #f6f8fa;
  --u-good: #1a7f37; --u-warn: #9a6700; --u-bad: #cf222e; --u-pending: #8c959f; --u-accent: #0969da;
  --u-shadow: 0 1px 2px rgba(31,35,40,.06), 0 8px 24px rgba(66,74,83,.14);
  --u-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --u-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :host, :root {
    --u-bg: #0d1117; --u-fg: #e6edf3; --u-muted: #9198a1; --u-line: #3d444d; --u-soft: #151b23;
    --u-good: #3fb950; --u-warn: #d29922; --u-bad: #f85149; --u-pending: #656c76; --u-accent: #4493f8;
    --u-shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(1,4,9,.6);
  }
}
* { box-sizing: border-box; }
.u { font: 13px/1.4 var(--u-font); color: var(--u-fg); -webkit-font-smoothing: antialiased; }
.u button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.u button:focus-visible, .u select:focus-visible, .u input:focus-visible { outline: 2px solid var(--u-accent); outline-offset: 2px; border-radius: 4px; }

.u-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; }
.u-mark { display: inline-flex; color: var(--u-fg); }
.u-brand { font-weight: 600; letter-spacing: -.01em; }
.u-site { color: var(--u-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.u-spacer { flex: 1; }
.u .u-x { width: 24px; height: 24px; border-radius: 6px; color: var(--u-muted); display: grid; place-items: center; font-size: 16px; line-height: 1; }
.u .u-x:hover { background: var(--u-soft); color: var(--u-fg); }

.u-rows { list-style: none; margin: 0; padding: 0 6px; }
.u-row { display: grid; grid-template-columns: 74px 1fr; gap: 8px; padding: 7px 8px; border-radius: 8px; }
.u-row + .u-row { border-top: 1px solid var(--u-line); border-radius: 0; }
.u-label { font-size: 11px; line-height: 19px; text-transform: uppercase; letter-spacing: .05em; color: var(--u-muted); }
.u-main { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.u-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; transform: translateY(-1px); background: var(--u-pending); }
.u-dot[data-tone="good"] { background: var(--u-good); }
.u-dot[data-tone="warn"] { background: var(--u-warn); }
.u-dot[data-tone="bad"] { background: var(--u-bad); }
.u-dot[data-tone="neutral"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--u-pending); }
.u-dot[data-tone="pending"] { animation: u-pulse 1.2s ease-in-out infinite; }
.u-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.u-row[data-tone="bad"] .u-text { color: var(--u-bad); font-weight: 600; white-space: normal; }
.u-sub { grid-column: 2; margin: -2px 0 0 14px; font-size: 12px; color: var(--u-muted); overflow: hidden; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.u-details { grid-column: 1 / -1; margin: 4px 0 2px; padding: 8px 10px; list-style: none; background: var(--u-soft); border-radius: 6px;
  font: 11.5px/1.55 var(--u-mono); color: var(--u-muted); overflow-wrap: anywhere; }
.u-details:empty { display: none; }

.u-foot { display: flex; gap: 4px; padding: 8px 10px 10px; border-top: 1px solid var(--u-line); }
.u .u-link { padding: 4px 6px; border-radius: 6px; color: var(--u-accent); font-weight: 500; }
.u .u-link:hover { background: var(--u-soft); }
.u .u-link.u-quiet { color: var(--u-muted); font-weight: 400; }
.u .u-danger { color: var(--u-bad); }

@keyframes u-pulse { 50% { opacity: .35; } }
@keyframes u-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .u-dot[data-tone="pending"], .u-card { animation: none !important; } }
`;

export const MODAL_STYLES = `
:host { all: initial; }
.u-card { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 344px; max-width: calc(100vw - 32px);
  background: var(--u-bg); border: 1px solid var(--u-line); border-radius: 12px; box-shadow: var(--u-shadow);
  animation: u-in .18s cubic-bezier(.2,.8,.2,1); }
.u-card[data-tone="bad"] { border-color: var(--u-bad); box-shadow: 0 0 0 1px var(--u-bad), var(--u-shadow); }
`;
