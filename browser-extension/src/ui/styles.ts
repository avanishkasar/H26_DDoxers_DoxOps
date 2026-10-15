// One stylesheet for the popup and the in-page panel (inserted as a <style> text node, never HTML).
// .dx is dark by default; .dx-auto switches to light colours when the system prefers light.

export const CSS = `
.dx {
  --dx-bg: #0d1117; --dx-panel: #161b22; --dx-border: #30363d; --dx-text: #e6edf3; --dx-muted: #8b949e;
  --dx-accent: #58a6ff; --dx-btn: #21262d; --dx-btn-hover: #30363d;
  --dx-critical: #f85149; --dx-high: #f0883e; --dx-medium: #d29922; --dx-low: #8b949e; --dx-none: #3fb950;
  --dx-verified: #3fb950; --dx-ai: #bc8cff; --dx-observed: #58a6ff;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: var(--dx-text); background: var(--dx-bg); box-sizing: border-box;
}
@media (prefers-color-scheme: light) {
  .dx.dx-auto {
    --dx-bg: #ffffff; --dx-panel: #f6f8fa; --dx-border: #d0d7de; --dx-text: #1f2328; --dx-muted: #59636e;
    --dx-accent: #0969da; --dx-btn: #f6f8fa; --dx-btn-hover: #eaeef2;
    --dx-critical: #cf222e; --dx-high: #bc4c00; --dx-medium: #9a6700; --dx-low: #6e7781; --dx-none: #1a7f37;
    --dx-verified: #1a7f37; --dx-ai: #8250df; --dx-observed: #0969da;
  }
  .dx.dx-auto .dx-score { color: #ffffff; }
}
.dx *, .dx *::before, .dx *::after { box-sizing: inherit; }
.dx h1 { font-size: 15px; margin: 0; font-weight: 600; }
.dx h2 { font-size: 12px; margin: 14px 0 6px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--dx-muted); }
.dx .dx-repo { color: var(--dx-muted); font-size: 12px; word-break: break-all; }
.dx .dx-summary { margin: 8px 0 10px; font-size: 13px; }
.dx .dx-summary strong { font-weight: 600; }
.dx .dx-msg { padding: 10px; border: 1px solid var(--dx-border); border-radius: 6px; background: var(--dx-panel); margin: 8px 0; }
.dx .dx-warn { color: var(--dx-muted); font-size: 11px; margin: 4px 0; }
.dx ul.dx-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dx li.dx-dep { border: 1px solid var(--dx-border); border-left-width: 4px; border-radius: 6px; padding: 7px 9px; background: var(--dx-panel); }
.dx li.dx-sev-critical { border-left-color: var(--dx-critical); }
.dx li.dx-sev-high { border-left-color: var(--dx-high); }
.dx li.dx-sev-medium { border-left-color: var(--dx-medium); }
.dx li.dx-sev-low { border-left-color: var(--dx-low); }
.dx li.dx-sev-none { border-left-color: var(--dx-none); }
.dx .dx-dep-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.dx .dx-name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dx .dx-ver { color: var(--dx-muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dx .dx-score { margin-left: auto; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 10px; color: #0d1117; }
.dx .dx-score.dx-sev-critical { background: var(--dx-critical); }
.dx .dx-score.dx-sev-high { background: var(--dx-high); }
.dx .dx-score.dx-sev-medium { background: var(--dx-medium); }
.dx .dx-score.dx-sev-low { background: var(--dx-low); }
.dx .dx-score.dx-sev-none { background: var(--dx-none); }
.dx ul.dx-ind { list-style: none; margin: 5px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dx ul.dx-ind li { font-size: 12px; }
.dx .dx-ind-title { font-weight: 500; }
.dx .dx-ind-detail { color: var(--dx-muted); font-size: 11px; display: block; word-break: break-word; }
.dx .dx-badge { display: inline-block; font-size: 9.5px; font-weight: 700; letter-spacing: .04em; padding: 0 5px; border-radius: 4px; border: 1px solid currentColor; margin-right: 5px; vertical-align: 1px; }
.dx .dx-badge-observed { color: var(--dx-observed); }
.dx .dx-badge-verified { color: var(--dx-verified); }
.dx .dx-badge-ai { color: var(--dx-ai); }
.dx .dx-status { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 10px; border: 1px solid currentColor; }
.dx .dx-status-verified { color: var(--dx-verified); }
.dx .dx-status-partially-verified { color: var(--dx-medium); }
.dx .dx-status-unverified { color: var(--dx-high); }
.dx .dx-status-failed { color: var(--dx-critical); }
.dx .dx-status-not-attempted { color: var(--dx-muted); }
.dx .dx-repl { margin-top: 4px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dx .dx-note { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--dx-border); color: var(--dx-muted); font-size: 11px; }
.dx .dx-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
.dx button, .dx .dx-file-label {
  font: inherit; font-size: 12px; color: var(--dx-text); background: var(--dx-btn); border: 1px solid var(--dx-border);
  border-radius: 6px; padding: 5px 10px; cursor: pointer;
}
.dx button:hover, .dx .dx-file-label:hover { background: var(--dx-btn-hover); }
.dx button.dx-primary { background: #238636; border-color: #2ea043; color: #fff; }
.dx button.dx-primary:hover { background: #2ea043; }
.dx button:focus-visible, .dx .dx-file-label:focus-within { outline: 2px solid var(--dx-accent); outline-offset: 1px; }
.dx .dx-toast { font-size: 11px; color: var(--dx-none); min-height: 14px; }
.dx .dx-spinner { width: 14px; height: 14px; border: 2px solid var(--dx-border); border-top-color: var(--dx-accent); border-radius: 50%; display: inline-block; animation: dx-spin .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
@keyframes dx-spin { to { transform: rotate(360deg); } }
`;

/** Extra rules for the in-page badge and panel (inside a closed shadow root). */
export const CONTENT_CSS = `
:host { all: initial; }
.dx-fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; background: transparent; }
.dx-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 12px; font-weight: 600; font-size: 12px; border: 1px solid var(--dx-border); background: var(--dx-panel); color: var(--dx-text); cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.25); }
.dx-pill .dx-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dx-dot.dx-sev-critical { background: var(--dx-critical); }
.dx-dot.dx-sev-high { background: var(--dx-high); }
.dx-dot.dx-sev-medium { background: var(--dx-medium); }
.dx-dot.dx-sev-low { background: var(--dx-low); }
.dx-dot.dx-sev-none { background: var(--dx-none); }
.dx-panel { width: 360px; max-width: calc(100vw - 32px); max-height: min(70vh, 560px); overflow: auto; border: 1px solid var(--dx-border); border-radius: 10px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35); background: var(--dx-bg); }
.dx-panel[hidden] { display: none; }
.dx-panel-head { display: flex; align-items: center; gap: 8px; }
.dx-panel-head h1 { flex: 1; }
.dx-close { padding: 2px 8px !important; }
`;
