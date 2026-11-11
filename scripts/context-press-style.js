// Context Press owns these scoped runtime tokens; DESIGN.md documents this map.
const cpCss = `
.broke-context-press{--cp-paper:#f0f3ff;--cp-ink:#1c2451;--cp-muted:#596385;--cp-line:#d7ddf1;--cp-blue:#3456ec;--cp-lavender:#cad2ff;--cp-teal:#72dbcf;--cp-violet:#9b81de;--cp-navy:#202c61;box-sizing:border-box;width:980px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);margin:auto;padding:0;border:1px solid var(--cp-line);border-radius:14px;background:#fff;color:var(--cp-ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:normal;box-shadow:0 18px 60px #172a492e;overflow:hidden}
.broke-context-press::backdrop{background:rgba(15,23,42,.55)}
.broke-context-press *{box-sizing:border-box}
.broke-context-press .cp-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 26px);min-height:0}
.broke-context-press .cp-head,.broke-context-press .cp-foot{flex:none;display:flex;justify-content:space-between;align-items:center;gap:14px;padding:18px 24px;background:#fafbff}
.broke-context-press .cp-head{border-bottom:1px solid var(--cp-line)}
.broke-context-press .cp-title{font:700 23px/1.2 Bahnschrift,'Segoe UI',sans-serif;letter-spacing:-.04em;margin:0;color:var(--cp-ink)}
.broke-context-press .cp-subtitle{font-size:12px;color:var(--cp-muted);margin:4px 0 0}
.broke-context-press .cp-head-actions{display:flex;gap:12px;align-items:center}
.broke-context-press .cp-tabs{display:flex;padding:3px;border:1px solid var(--cp-line);border-radius:9px;background:var(--cp-paper)}
.broke-context-press button{font-family:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;min-height:36px;padding:7px 12px;border:1px solid var(--cp-line);border-radius:6px;background:#fff;color:var(--cp-ink)}
.broke-context-press button:hover{background:#edf1ff}
.broke-context-press button:disabled{cursor:not-allowed;opacity:.6}
.broke-context-press button:focus-visible,.broke-context-press input:focus-visible,.broke-context-press select:focus-visible,.broke-context-press summary:focus-visible{outline:3px solid var(--cp-blue);outline-offset:3px}
.broke-context-press .cp-tab{background:transparent;border-color:transparent;min-height:32px;font-size:12px}
.broke-context-press .cp-tab[aria-selected=true]{background:#fff;border-color:var(--cp-line)}
.broke-context-press .cp-close{font-size:21px;padding:1px 8px;min-width:34px;background:transparent;border-color:transparent}
.broke-context-press .cp-body{padding:22px 24px;overflow:auto;min-height:0;scrollbar-gutter:stable}
.broke-context-press [hidden]{display:none!important}
.broke-context-press h2,.broke-context-press h3,.broke-context-press p{margin:0}
.broke-context-press .cp-hero h2{font:650 29px/1.15 Bahnschrift,'Segoe UI',sans-serif;letter-spacing:-.035em}
.broke-context-press .cp-hero p{font-size:13px;color:var(--cp-muted);margin-top:7px}
.broke-context-press .cp-status{margin-top:14px;border-left:3px solid #185d82;background:#eef7fb;border-radius:0 6px 6px 0;padding:11px 13px;font-size:13px}
.broke-context-press .cp-status strong{display:block;margin-bottom:4px}
.broke-context-press .cp-stage-layout{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(240px,1fr);gap:18px;margin-top:19px;align-items:stretch}
.broke-context-press .cp-material{position:relative;background:var(--cp-navy);border-radius:12px;overflow:hidden;min-height:275px;isolation:isolate;color:#eef2ff}
.broke-context-press .cp-material:before{content:'';position:absolute;inset:0;background-image:linear-gradient(#8b9dd320 1px,transparent 1px),linear-gradient(90deg,#8b9dd320 1px,transparent 1px);background-size:32px 32px;pointer-events:none}
.broke-context-press .cp-material svg{display:block;width:100%;height:250px;position:relative}
.broke-context-press .cp-visual-caption{position:absolute;bottom:13px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:11px;color:#d4def9}
.broke-context-press .cp-replay{background:#344176;color:#eef2ff;border-color:#6677a7;min-height:29px;padding:3px 8px;font-size:11px}
.broke-context-press .cp-pages{transform-origin:430px 150px;transition:transform .35s ease}
.broke-context-press .cp-replaying .cp-pages{animation:cp-press .8s ease}
.broke-context-press .cp-depth{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.broke-context-press .cp-depth legend{font-size:12px;font-weight:650;color:var(--cp-muted);margin-bottom:8px}
.broke-context-press .cp-option{display:block;position:relative;cursor:pointer;border:1px solid var(--cp-line);border-radius:9px;padding:11px 13px;flex:1;background:#fff;font-size:13px;min-width:0}
.broke-context-press .cp-option input{position:absolute;top:15px;right:12px;accent-color:var(--cp-blue);width:15px;height:15px;margin:0}
.broke-context-press .cp-option strong{display:block;padding-right:20px;font-size:14px}
.broke-context-press .cp-option p{font-size:12px;color:var(--cp-muted);margin-top:4px;padding-right:14px}
.broke-context-press .cp-option small{display:block;font-size:11px;margin-top:7px;color:var(--cp-muted)}
.broke-context-press .cp-option.cp-included{background:#f7f9ff;border-color:#aab9ee}
.broke-context-press .cp-option.cp-selected{border:2px solid var(--cp-blue);padding:10px 12px;background:#edf1ff}
.broke-context-press .cp-option:has(input:focus-visible){outline:3px solid var(--cp-blue);outline-offset:3px}
.broke-context-press .cp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.broke-context-press .cp-enable{margin-top:17px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:9px}
.broke-context-press .cp-enable input,.broke-context-press .cp-record input{accent-color:var(--cp-blue);width:17px;height:17px}
.broke-context-press .cp-small{font-size:12px;color:var(--cp-muted)}
.broke-context-press .cp-selection{margin-top:16px;padding-top:14px;border-top:1px solid var(--cp-line);font-size:13px}
.broke-context-press .cp-selection p{font-size:12px;color:var(--cp-muted);margin-top:4px}
.broke-context-press .cp-safe-note{font-size:12px;color:var(--cp-muted);margin-top:13px}
.broke-context-press .cp-alert,.broke-context-press .cp-error,.broke-context-press .cp-intro{margin:0 0 16px;padding:13px 15px;border-radius:7px;font-size:13px;line-height:1.5}
.broke-context-press .cp-alert{background:#fff5ed;border:1px solid #ebcebd;color:#784d31;margin-top:14px}
.broke-context-press .cp-error{background:#fff4f2;border:1px solid #e5bfb7;color:#8a2d24}
.broke-context-press .cp-intro{background:#f0f3ff;border:1px solid var(--cp-line)}
.broke-context-press .cp-intro h2{font-size:17px;margin-bottom:6px}
.broke-context-press .cp-setup{padding:13px 15px;background:#eef7fb;border:1px solid #b8d8e8;border-radius:8px;margin-top:14px;font-size:13px}
.broke-context-press .cp-setup dl{margin:8px 0}.broke-context-press .cp-setup dt{font-weight:650}.broke-context-press .cp-setup dd{margin:2px 0 10px}
.broke-context-press .cp-advanced{margin-top:18px;border-top:1px solid var(--cp-line);padding-top:10px}
.broke-context-press .cp-advanced>summary{padding:6px 0;font-weight:650;font-size:13px;cursor:pointer}
.broke-context-press .cp-foot{border-top:1px solid var(--cp-line);padding:13px 24px}
.broke-context-press .cp-foot-actions{display:flex;gap:8px}
.broke-context-press .cp-foot-actions .cp-save{color:#fff;background:var(--cp-blue);border-color:var(--cp-blue);min-width:100px}
.broke-context-press .cp-foot-actions .cp-save:hover{background:#2440b9}
.broke-context-press .cp-meta{font-size:11px;color:var(--cp-muted)}
.broke-context-press .cp-meta strong{display:block;color:var(--cp-ink);font-size:12px}
.broke-context-press .cp-filter{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--cp-muted)}
.broke-context-press .cp-filter select{font:inherit;min-height:36px;padding:7px 9px;border:1px solid var(--cp-line);border-radius:6px;background:#fff;color:var(--cp-ink)}
.broke-context-press .cp-stat-top{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;margin:20px 0}
.broke-context-press .cp-number{display:block;font:650 48px/1.1 Bahnschrift,'Segoe UI',sans-serif;letter-spacing:-.045em;font-variant-numeric:tabular-nums}
.broke-context-press .cp-unit-label{font-size:11px;color:var(--cp-blue);margin-bottom:4px}
.broke-context-press .cp-toolbar{border-top:1px solid var(--cp-line);padding-top:15px;margin-top:15px;display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap}
.broke-context-press .cp-toggles{display:flex;gap:5px}
.broke-context-press .cp-toggles button{min-height:31px;font-size:12px;padding:5px 9px}
.broke-context-press button[aria-pressed=true]{background:#edf1ff;color:var(--cp-blue);border-color:#8ca1f2}
.broke-context-press .cp-bar{display:grid;grid-template-columns:120px 1fr 82px;gap:12px;align-items:center;width:100%;padding:12px 3px;border:0;border-bottom:1px solid #edf0f7;border-radius:0;background:transparent;text-align:left;font-size:12px}
.broke-context-press .cp-bar-track{display:block;height:17px;background:#edf1fa;border-radius:3px;overflow:hidden}
.broke-context-press .cp-bar-fill{display:block;height:100%;border-radius:3px}
.broke-context-press .cp-value{text-align:right;font:12px ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.broke-context-press .cp-detail{margin-top:13px;background:#f3f6ff;border-left:3px solid var(--cp-blue);padding:12px 14px;font-size:12px}
.broke-context-press .cp-detail strong{display:block;margin-bottom:4px}
.broke-context-press .cp-net-row{display:flex;justify-content:space-between;gap:15px;font-size:12px;padding:12px 0;border-bottom:1px solid var(--cp-line)}
.broke-context-press .cp-chart-scroll{overflow-x:auto;margin-top:12px;border-bottom:1px solid var(--cp-line)}
.broke-context-press .cp-timeline{display:flex;gap:7px;min-width:100%;width:max-content;align-items:flex-end}
.broke-context-press .cp-run{position:relative;padding:0;min-width:27px;width:36px;height:158px;background:transparent;border:1px solid transparent;border-radius:4px;flex:none}
.broke-context-press .cp-run-canvas{position:absolute;left:4px;right:4px;top:5px;bottom:23px;border-top:1px solid transparent}
.broke-context-press .cp-zero{position:absolute;left:0;right:0;top:65px;height:1px;background:#b6c2e3}
.broke-context-press .cp-run-bar{position:absolute;left:2px;right:2px;border-radius:3px;background:var(--cp-blue)}
.broke-context-press .cp-run-index{position:absolute;bottom:3px;left:0;right:0;font-size:10px;text-align:center;color:var(--cp-muted)}
.broke-context-press .cp-record{display:flex;gap:8px;align-items:center;cursor:pointer;font-size:12px}
.broke-context-press .cp-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
.broke-context-press .cp-table td,.broke-context-press .cp-table th{padding:8px 6px;border-bottom:1px solid #e7ecf7;text-align:left}
.broke-context-press .cp-table th{font-weight:650}
.broke-context-press .cp-table td:last-child{text-align:right}
.broke-context-press .cp-disclosure{margin-top:15px;padding-top:12px;border-top:1px solid var(--cp-line);font-size:12px}
.broke-context-press .cp-disclosure>summary{font-weight:600;cursor:pointer}
.broke-context-press .cp-chart-note{font-size:12px;color:var(--cp-muted);margin-top:12px}
@keyframes cp-press{0%,100%{opacity:1}45%{opacity:.55;transform:scaleY(.35)}}
@media(max-width:760px){.broke-context-press .cp-stage-layout{grid-template-columns:1fr}.broke-context-press .cp-depth{flex-direction:row;flex-wrap:wrap}.broke-context-press .cp-depth legend{width:100%}.broke-context-press .cp-option{flex:1;min-width:0}.broke-context-press .cp-option strong{font-size:13px}.broke-context-press .cp-option p{font-size:11px;padding-right:0}.broke-context-press .cp-material{min-height:240px}.broke-context-press .cp-material svg{height:220px}.broke-context-press .cp-hero h2{font-size:25px}}
@media(max-width:420px){.broke-context-press .cp-head,.broke-context-press .cp-foot{padding:12px}.broke-context-press .cp-head{align-items:flex-start}.broke-context-press .cp-title{font-size:19px}.broke-context-press .cp-subtitle{font-size:11px}.broke-context-press .cp-head-actions{gap:3px;flex-wrap:wrap;justify-content:flex-end}.broke-context-press .cp-tab{padding:5px 7px;font-size:11px}.broke-context-press .cp-body{padding:16px 12px}.broke-context-press .cp-depth{gap:5px}.broke-context-press .cp-option{padding:10px 8px}.broke-context-press .cp-option.cp-selected{padding:9px 7px}.broke-context-press .cp-option input{right:6px;width:12px;height:12px;top:13px}.broke-context-press .cp-option strong{font-size:12px;padding-right:10px}.broke-context-press .cp-option small{font-size:10px}.broke-context-press .cp-stat-top{grid-template-columns:1fr;gap:10px}.broke-context-press .cp-number{font-size:39px}.broke-context-press .cp-bar{grid-template-columns:92px 1fr 65px;gap:6px}.broke-context-press .cp-filter select{max-width:130px}.broke-context-press .cp-meta{max-width:125px}.broke-context-press .cp-foot-actions{gap:4px}.broke-context-press .cp-foot-actions button{padding:6px 9px}.broke-context-press .cp-foot-actions .cp-save{min-width:72px}}
@media(prefers-reduced-motion:reduce){.broke-context-press *{animation:none!important;transition:none!important}}
@media(forced-colors:active){.broke-context-press .cp-option.cp-selected{border-color:Highlight}.broke-context-press .cp-bar-fill,.broke-context-press .cp-run-bar{background:Highlight!important}.broke-context-press .cp-material{border:1px solid CanvasText}}
`;
