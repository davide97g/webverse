(() => {
  if (window.top !== window || window.__webverseLoaded) return;
  window.__webverseLoaded = true;

  const HOST = location.hostname.replace(/^www\./, '').toLowerCase();
  if (!/^https?:$/.test(location.protocol) || !HOST) return;
  const CHAT_KEY = 'chat:' + HOST;
  const MAX_CHAT = 60;
  const ICONS = globalThis.WV_ICONS || {};
  const MD = globalThis.WV_MD || { render: (t) => t };

  const state = {
    corner: 'br',
    visible: true,
    open: false,
    wide: false,
    busy: false,
    chat: [],
    element: null, // { selector, html }
    attachments: [], // { dataUrl, thumb, name }
    activity: null, // { startedAt, steps: [] }
    health: null,
    picking: false,
  };
  let contextTarget = null;
  let port = null;

  document.addEventListener('contextmenu', (e) => { contextTarget = e.target; }, true);

  // ---------------------------------------------------------------------------
  // DOM snapshot sent to Claude (one element per line, indented)
  // ---------------------------------------------------------------------------
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'SOURCE', 'WEBVERSE-ROOT', 'BASE']);
  const KEEP_ATTR = /^(id|class|role|href|src|alt|title|type|name|placeholder|contenteditable|tabindex|for|aria-[\w-]+|data-[\w-]+)$/;
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  function serialize(rootEl, maxBytes) {
    const out = [];
    let size = 0;
    let truncated = false;
    const push = (s) => {
      if (size > maxBytes) { truncated = true; return; }
      out.push(s);
      size += s.length + 1;
    };
    const attrs = (el) => {
      let s = '';
      for (const a of el.attributes) {
        if (!KEEP_ATTR.test(a.name) || a.name.startsWith('data-wv')) continue;
        let v = a.value;
        if (a.name === 'src' && v.startsWith('data:')) v = 'data:…';
        s += ` ${a.name}="${clip(v, a.name === 'class' ? 200 : 120).replace(/"/g, '&quot;')}"`;
      }
      return s;
    };
    const walk = (node, depth) => {
      if (truncated) return;
      const pad = '  '.repeat(Math.min(depth, 40));
      if (node.nodeType === 3) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) push(pad + clip(t, 300));
        return;
      }
      if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'svg') { push(`${pad}<svg${attrs(node)}/>`); return; }
      const kids = [...node.childNodes].filter((c) => (c.nodeType === 1 ? !SKIP.has(c.tagName) : c.nodeType === 3 && c.textContent.trim()));
      const sh = node.shadowRoot ? ' data-wv-has-shadow' : '';
      if (!kids.length) { push(`${pad}<${tag}${attrs(node)}${sh}></${tag}>`); return; }
      if (kids.length === 1 && kids[0].nodeType === 3) {
        push(`${pad}<${tag}${attrs(node)}${sh}>${clip(kids[0].textContent.replace(/\s+/g, ' ').trim(), 300)}</${tag}>`);
        return;
      }
      push(`${pad}<${tag}${attrs(node)}${sh}>`);
      for (const c of kids) walk(c, depth + 1);
      push(`${pad}</${tag}>`);
    };
    walk(rootEl, 0);
    if (truncated) out.push('<!-- webverse: snapshot truncated -->');
    return out.join('\n');
  }

  const snapshotPage = () =>
    `<!-- url: ${location.href} | viewport: ${innerWidth}x${innerHeight} | scrollY: ${Math.round(scrollY)} -->\n` +
    serialize(document.documentElement, 4_000_000);

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && !/\d{3,}/.test(el.id)) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
      let p = el.tagName.toLowerCase();
      const aria = el.getAttribute('aria-label');
      const cls = [...el.classList].filter((c) => !/\d{3,}|^ember|^data-wv/.test(c)).slice(0, 2);
      if (aria && aria.length < 60) p += `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
      else if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(p);
      el = parent;
    }
    return parts.join(' > ');
  }

  const shortLabel = (el) => {
    let s = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (el.id) s += '#' + el.id;
    else if (aria) s += `[${clip(aria, 28)}]`;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    const r = el.getBoundingClientRect();
    return `${clip(s, 60)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  };

  // ---------------------------------------------------------------------------
  // Markup + styles
  // ---------------------------------------------------------------------------
  const icon = (name, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  const rootHost = document.createElement('webverse-root');
  rootHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const shadow = rootHost.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
<style>
  /* Tokens. Radius rule: panel 16, controls 10, chips/bubble full. One accent: cobalt. */
  :host {
    --bg: #fbfbfc; --surface: #f2f3f6; --surface-2: #e8eaf0; --line: #e0e2e9;
    --text: #16171b; --muted: #5b5f6e; --faint: #8a8e9c;
    --accent: #3451e0; --accent-ink: #ffffff; --accent-soft: rgba(52, 81, 224, .10);
    --danger: #c2283c; --danger-soft: #fcebee; --warn-ink: #6f4500; --warn-soft: #fff3d6;
    --bubble: #16171b; --bubble-ink: #ffffff;
    --shadow: 0 28px 64px -16px rgba(22, 23, 27, .30), 0 2px 8px rgba(22, 23, 27, .08);
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --ease: cubic-bezier(.16, 1, .3, 1);
    all: initial;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #17181c; --surface: #1f2026; --surface-2: #292b33; --line: #2e3039;
      --text: #ecedf2; --muted: #a2a6b4; --faint: #737787;
      --accent: #7d93ff; --accent-ink: #0d1230; --accent-soft: rgba(125, 147, 255, .14);
      --danger: #ff8a96; --danger-soft: rgba(255, 90, 110, .12); --warn-ink: #ffd58a; --warn-soft: rgba(255, 190, 80, .11);
      --bubble: #ecedf2; --bubble-ink: #17181c;
      --shadow: 0 28px 64px -16px rgba(0, 0, 0, .7), 0 0 0 1px rgba(255, 255, 255, .04);
    }
  }
  * { box-sizing: border-box; margin: 0; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  svg { display: block; flex: none; }
  [hidden] { display: none !important; }

  /* Bubble */
  .bubble { position: relative; width: 52px; height: 52px; border-radius: 999px; display: grid; place-items: center;
    background: var(--bubble); color: var(--bubble-ink); box-shadow: var(--shadow); touch-action: none; user-select: none;
    transition: transform .2s var(--ease); }
  .bubble:hover { transform: translateY(-2px); }
  .bubble:active { transform: scale(.96); }
  .bubble.dragging { cursor: grabbing; transition: none; }
  .bubble .count { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
    background: var(--accent); color: var(--accent-ink); font: 600 11px/20px var(--sans); text-align: center;
    box-shadow: 0 0 0 2px var(--bubble-ink); }
  .bubble .ring { position: absolute; inset: -4px; border-radius: 999px; pointer-events: none; opacity: 0;
    background: conic-gradient(from 0deg, transparent 0 60%, var(--accent) 100%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); }
  .bubble.busy .ring { opacity: 1; animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }

  /* Panel */
  .panel { position: absolute; width: min(400px, calc(100vw - 32px)); height: min(600px, calc(100vh - 104px));
    display: flex; flex-direction: column; overflow: hidden; border-radius: 16px;
    background: var(--bg); color: var(--text); border: 1px solid var(--line); box-shadow: var(--shadow);
    font: 400 13.5px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
    opacity: 0; visibility: hidden; transform: translateY(var(--dy, 8px)) scale(.97);
    transition: opacity .16s ease-in, transform .16s ease-in, visibility 0s linear .16s; }
  .panel.open { opacity: 1; visibility: visible; transform: none;
    transition: opacity .22s var(--ease), transform .26s var(--ease), visibility 0s; }
  .panel.wide { width: min(640px, calc(100vw - 32px)); height: min(820px, calc(100vh - 104px)); }
  :host([data-corner^="b"]) .panel { bottom: 64px; --dy: 8px; }
  :host([data-corner^="t"]) .panel { top: 64px; --dy: -8px; }
  :host([data-corner$="r"]) .panel { right: 0; transform-origin: bottom right; }
  :host([data-corner$="l"]) .panel { left: 0; transform-origin: bottom left; }
  :host([data-corner="tr"]) .panel { transform-origin: top right; }
  :host([data-corner="tl"]) .panel { transform-origin: top left; }

  header { display: flex; align-items: center; gap: 10px; padding: 12px 10px 12px 16px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
  .mark { width: 28px; height: 28px; border-radius: 999px; display: grid; place-items: center; background: var(--bubble); color: var(--bubble-ink); }
  .titles { min-width: 0; line-height: 1.2; }
  .titles b { display: block; font-weight: 650; font-size: 13.5px; letter-spacing: -.01em; }
  .titles span { display: block; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tools { display: flex; align-items: center; gap: 2px; position: relative; }
  .ib { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; color: var(--muted);
    transition: background .15s, color .15s; }
  .ib:hover { background: var(--surface); color: var(--text); }
  .ib:active { transform: scale(.94); }
  .ib.off { color: var(--danger); }
  .ib:disabled { opacity: .4; cursor: default; background: none; }
  .feat { height: 28px; padding: 0 10px 0 8px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 550; color: var(--muted); background: var(--surface); margin-right: 4px; }
  .feat:hover { color: var(--text); background: var(--surface-2); }
  .feat.on { color: var(--accent); background: var(--accent-soft); }

  .menu { position: absolute; top: 38px; right: 0; z-index: 3; min-width: 220px; padding: 6px; border-radius: 12px;
    background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow); }
  .menu button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; text-align: left; color: var(--text); }
  .menu button:hover { background: var(--surface); }
  .menu button svg { color: var(--muted); }
  .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 6px; }

  .sheet { border-bottom: 1px solid var(--line); background: var(--surface); padding: 12px 16px 14px; max-height: 45%; overflow-y: auto; }
  .sheet h3 { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 8px; }
  .sheet .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
  .sheet .row + .row { border-top: 1px solid var(--line); }
  .sheet .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag { font: 500 10.5px/18px var(--mono); padding: 0 6px; border-radius: 999px; color: var(--muted); background: var(--surface-2); }
  .sheet .rm { font-size: 12px; color: var(--muted); padding: 4px 8px; border-radius: 8px; }
  .sheet .rm:hover { color: var(--danger); background: var(--danger-soft); }
  .sheet .none { color: var(--muted); font-size: 12.5px; }

  .banner { display: flex; gap: 10px; margin: 12px 16px 0; padding: 10px 12px; border-radius: 10px;
    background: var(--warn-soft); color: var(--warn-ink); font-size: 12.5px; line-height: 1.45; }
  .banner code { font: 12px var(--mono); }

  /* Log */
  .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; scroll-behavior: smooth; overscroll-behavior: contain; }
  .log::-webkit-scrollbar { width: 10px; }
  .log::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 10px; border: 3px solid var(--bg); }
  .m.fresh { animation: rise .26s var(--ease) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  .m.user { align-self: flex-end; max-width: 86%; background: var(--surface); border-radius: 16px 16px 4px 16px; padding: 9px 13px;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .m.user .imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; justify-content: flex-end; }
  .m.user .imgs img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); }
  .m.user .el { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--muted); font: 11.5px var(--mono); overflow: hidden; }
  .m.user .el span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m.ai { align-self: stretch; overflow-wrap: anywhere; }
  .m.note { align-self: center; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .m.note svg { color: var(--accent); }
  .m.error { display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--danger-soft); color: var(--danger); font-size: 12.5px; }
  .m.error div { white-space: pre-wrap; overflow-wrap: anywhere; }

  .md > * + * { margin-top: .6em; }
  .md h3, .md h4, .md h5, .md h6 { font-size: 13.5px; font-weight: 650; }
  .md ul, .md ol { padding-left: 1.3em; }
  .md li + li { margin-top: .2em; }
  .md a { color: var(--accent); text-underline-offset: 2px; }
  .md code { font: 12px var(--mono); background: var(--surface); padding: 1px 5px; border-radius: 5px; }
  .md pre { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; overflow-x: auto; }
  .md pre code { background: none; padding: 0; font-size: 12px; line-height: 1.5; white-space: pre; }
  .md pre .cp { position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
    color: var(--muted); background: var(--bg); border: 1px solid var(--line); opacity: 0; transition: opacity .15s; }
  .md pre:hover .cp, .md pre .cp:focus-visible { opacity: 1; }
  .md blockquote { border-left: 2px solid var(--line); padding-left: 10px; color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--line); }

  .foot { display: flex; align-items: center; gap: 4px; margin-top: 8px; color: var(--faint); font-size: 11.5px; }
  .foot .sp { flex: 1; }
  .foot .ib { width: 26px; height: 26px; border-radius: 8px; color: var(--faint); }
  .foot .ib:hover { color: var(--text); }
  details.steps { margin-top: 8px; font-size: 12px; color: var(--muted); }
  details.steps summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 4px; }
  details.steps summary::-webkit-details-marker { display: none; }
  details.steps summary svg { transition: transform .2s var(--ease); }
  details.steps[open] summary svg { transform: rotate(180deg); }
  details.steps ol { margin-top: 6px; padding-left: 18px; font-family: var(--mono); font-size: 11.5px; line-height: 1.7; color: var(--faint); }

  /* Activity (in-flight request) */
  .act { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; background: var(--bg); }
  .act .top { display: flex; align-items: center; gap: 10px; font-weight: 550; }
  .act .top .t { margin-left: auto; font: 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
  .act .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); animation: breathe 1.4s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .3; transform: scale(.8); } }
  .act ol { list-style: none; padding: 0; margin-top: 10px; display: flex; flex-direction: column; gap: 4px; font: 12px/1.5 var(--mono); color: var(--muted); }
  .act li { display: flex; gap: 8px; align-items: center; }
  .act li svg { color: var(--faint); }
  .act li.now { color: var(--text); }
  .act li.now svg { color: var(--accent); }
  .shimmer { height: 8px; border-radius: 999px; margin-top: 12px; background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%);
    background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* Empty state */
  .empty { margin: auto 0; padding: 8px 4px; }
  .empty h2 { font-size: 17px; font-weight: 650; letter-spacing: -.015em; line-height: 1.3; }
  .empty h2 em { font-style: normal; color: var(--accent); }
  .empty p { color: var(--muted); margin-top: 6px; font-size: 13px; }
  .sugg { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
  .sugg button { display: flex; align-items: center; gap: 10px; text-align: left; padding: 10px 12px; border-radius: 10px;
    border: 1px solid var(--line); color: var(--text); transition: border-color .15s, background .15s; }
  .sugg button:hover { border-color: var(--accent); background: var(--accent-soft); }
  .sugg button svg { color: var(--muted); }

  /* Composer */
  .composer { padding: 10px 12px 12px; }
  .box { border: 1px solid var(--line); border-radius: 14px; background: var(--bg); transition: border-color .15s, box-shadow .15s; }
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .box.drop { border-style: dashed; border-color: var(--accent); background: var(--accent-soft); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 8px 0; }
  .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 4px 0 9px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent); font: 11.5px var(--mono); }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
  .chip button { width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center; }
  .chip button:hover { background: var(--accent); color: var(--accent-ink); }
  .thumb { position: relative; width: 52px; height: 52px; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb button { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 999px; display: grid; place-items: center;
    background: rgba(10, 10, 14, .72); color: #fff; opacity: 0; transition: opacity .15s; }
  .thumb:hover button, .thumb button:focus-visible { opacity: 1; }
  textarea { display: block; width: 100%; resize: none; border: 0; outline: none; background: none; color: var(--text);
    font: 400 14px/1.5 var(--sans); padding: 10px 12px 4px; min-height: 44px; max-height: 180px; }
  textarea::placeholder { color: var(--faint); }
  textarea:focus-visible { outline: none; } /* the .box focus ring covers it */
  .bar { display: flex; align-items: center; gap: 2px; padding: 4px 6px 6px; }
  .bar .sp { flex: 1; }
  .bar .ib.active { color: var(--accent); background: var(--accent-soft); }
  .send { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink);
    transition: opacity .15s, transform .1s; }
  .send:active { transform: scale(.94); }
  .send:disabled { opacity: .35; cursor: default; }
  .send.stop { background: var(--text); color: var(--bg); }
  .hint { margin-top: 6px; padding: 0 4px; font-size: 11px; color: var(--faint); display: flex; justify-content: space-between; }
  kbd { font: 10.5px var(--mono); padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; }

  /* Element picker */
  .pick-box { position: fixed; pointer-events: none; z-index: 1; border: 2px solid var(--accent); border-radius: 4px;
    background: var(--accent-soft); transition: all .06s linear; }
  .pick-tag { position: fixed; pointer-events: none; z-index: 2; padding: 3px 8px; border-radius: 6px; max-width: 70vw;
    background: var(--accent); color: var(--accent-ink); font: 500 11.5px/1.4 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pick-hud { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2; display: flex; align-items: center; gap: 10px;
    padding: 8px 8px 8px 14px; border-radius: 999px; background: var(--bubble); color: var(--bubble-ink); box-shadow: var(--shadow);
    font: 500 13px var(--sans); }
  .pick-hud button { padding: 4px 10px; border-radius: 999px; background: rgba(127, 127, 127, .22); font-size: 12px; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001s !important; animation-iteration-count: 1 !important; transition-duration: .001s !important; }
    .bubble.busy .ring { animation: none; opacity: 1; }
  }
</style>

<button class="bubble" aria-label="Apri Webverse" title="Webverse (trascina per spostare)">
  ${icon('sparkles', 24)}<span class="ring"></span><span class="count" hidden></span>
</button>

<section class="panel" role="dialog" aria-label="Webverse">
  <header>
    <div class="brand">
      <div class="mark">${icon('sparkles', 16)}</div>
      <div class="titles"><b>Webverse</b><span class="site"></span></div>
    </div>
    <div class="tools">
      <button class="feat" data-act="features" aria-label="Modifiche attive">${icon('list-details', 15)}<span>0</span></button>
      <button class="ib" data-act="undo" aria-label="Annulla l'ultima modifica" title="Annulla l'ultima modifica">${icon('arrow-back-up')}</button>
      <button class="ib" data-act="toggle" aria-label="Attiva o disattiva le modifiche" title="Attiva/disattiva le modifiche su questo sito">${icon('power')}</button>
      <button class="ib" data-act="menu" aria-label="Altre azioni" aria-haspopup="menu" title="Altre azioni">${icon('dots')}</button>
      <button class="ib" data-act="close" aria-label="Chiudi" title="Chiudi (Esc)">${icon('x')}</button>
      <div class="menu" role="menu" hidden>
        <button role="menuitem" data-act="wide">${icon('arrows-diagonal', 16)}<span>Pannello grande</span></button>
        <button role="menuitem" data-act="new">${icon('message-plus', 16)}<span>Nuova conversazione</span></button>
        <button role="menuitem" data-act="pull">${icon('refresh', 16)}<span>Ricarica modifiche da disco</span></button>
        <hr>
        <button role="menuitem" data-act="hide">${icon('x', 16)}<span>Nascondi bolla (Alt+Shift+W)</span></button>
      </div>
    </div>
  </header>
  <div class="sheet" hidden></div>
  <div class="banner" role="status" hidden></div>
  <div class="log" aria-live="polite"></div>
  <div class="composer">
    <div class="box">
      <div class="chips" hidden></div>
      <textarea rows="1" aria-label="Messaggio" placeholder="Descrivi cosa cambiare…"></textarea>
      <div class="bar">
        <button class="ib" data-att="pick" aria-label="Scegli un elemento della pagina" title="Scegli un elemento della pagina">${icon('pointer')}</button>
        <button class="ib" data-att="shot" aria-label="Allega screenshot della pagina" title="Allega screenshot della pagina (senza chat)">${icon('camera')}</button>
        <button class="ib" data-att="file" aria-label="Allega immagine" title="Allega immagine (anche incolla o trascina)">${icon('paperclip')}</button>
        <input type="file" accept="image/*" multiple hidden>
        <span class="sp"></span>
        <button class="send" aria-label="Invia" title="Invia (Invio)" disabled>${icon('arrow-up')}</button>
      </div>
    </div>
    <div class="hint"><span><kbd>Invio</kbd> invia · <kbd>Shift</kbd>+<kbd>Invio</kbd> a capo</span><span class="site-hint"></span></div>
  </div>
</section>

<div class="pick-layer" hidden>
  <div class="pick-box"></div>
  <div class="pick-tag"></div>
  <div class="pick-hud">${icon('pointer', 16)}<span>Clicca l'elemento da modificare</span><button data-act="pick-cancel">Esc</button></div>
</div>`;

  const $ = (s) => shadow.querySelector(s);
  const bubble = $('.bubble');
  const countEl = $('.bubble .count');
  const panel = $('.panel');
  const logEl = $('.log');
  const input = $('textarea');
  const sendBtn = $('.send');
  const chipsEl = $('.chips');
  const banner = $('.banner');
  const sheet = $('.sheet');
  const menu = $('.menu');
  const box = $('.box');
  const fileInput = $('input[type=file]');
  const pickLayer = $('.pick-layer');
  const pickBox = $('.pick-box');
  const pickTag = $('.pick-tag');
  $('.site').textContent = HOST;

  const h = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------------------
  // Placement, drag, open/close
  // ---------------------------------------------------------------------------
  const MARGIN = 18;
  function place() {
    rootHost.setAttribute('data-corner', state.corner);
    const s = rootHost.style;
    s.left = s.right = s.top = s.bottom = '';
    s[state.corner[0] === 't' ? 'top' : 'bottom'] = MARGIN + 'px';
    s[state.corner[1] === 'l' ? 'left' : 'right'] = MARGIN + 'px';
    rootHost.style.display = state.visible ? '' : 'none';
  }

  let drag = null;
  bubble.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    if (!drag.moved) { drag.moved = true; bubble.classList.add('dragging'); if (state.open) setOpen(false); }
    const s = rootHost.style;
    s.right = s.bottom = '';
    s.left = Math.max(4, Math.min(innerWidth - 56, e.clientX - 26)) + 'px';
    s.top = Math.max(4, Math.min(innerHeight - 56, e.clientY - 26)) + 'px';
  });
  bubble.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    bubble.classList.remove('dragging');
    if (!moved) return setOpen(!state.open);
    state.corner = (e.clientY < innerHeight / 2 ? 't' : 'b') + (e.clientX < innerWidth / 2 ? 'l' : 'r');
    chrome.storage.local.set({ wvCorner: state.corner });
    place();
  });
  bubble.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!state.open); }
  });

  function setOpen(v) {
    state.open = v;
    panel.classList.toggle('open', v);
    bubble.setAttribute('aria-expanded', String(v));
    if (v) {
      render();
      refreshHealth();
      setTimeout(() => input.focus(), 30);
    } else {
      menu.hidden = true;
      sheet.hidden = true;
    }
  }

  function setVisible(v) {
    state.visible = v;
    chrome.storage.local.set({ wvVisible: v });
    place();
  }

  function setWide(v) {
    state.wide = v;
    panel.classList.toggle('wide', v);
    menu.querySelector('[data-act="wide"]').innerHTML = `${icon(v ? 'arrows-diagonal-minimize-2' : 'arrows-diagonal', 16)}<span>${v ? 'Pannello compatto' : 'Pannello grande'}</span>`;
    chrome.storage.local.set({ wvWide: v });
  }

  // ---------------------------------------------------------------------------
  // Chat model + rendering
  // ---------------------------------------------------------------------------
  const saveChat = () => chrome.storage.local.set({ [CHAT_KEY]: state.chat.slice(-MAX_CHAT) });

  function push(msg) {
    state.chat.push({ at: Date.now(), ...msg });
    saveChat();
    render();
  }

  const SUGGESTIONS = [
    ['eye-off', 'Nascondi le sezioni che distraggono e pulisci il layout'],
    ['layout-columns', 'Allarga la colonna principale e riduci le barre laterali'],
    ['link', "Aggiungi un bottone per copiare l'URL della pagina"],
    ['moon', 'Tema scuro morbido con un solo colore di accento'],
  ];

  function renderEmpty() {
    const e = h('div', 'empty');
    e.innerHTML = `<h2>Cosa vuoi cambiare su <em>${escHtml(HOST)}</em>?</h2>
      <p>Layout, colori, elementi da nascondere, nuove funzioni. Usa ${icon('pointer', 13).replace('<svg', '<svg style="display:inline;vertical-align:-2px"')} per indicare un elemento preciso.</p>`;
    const list = h('div', 'sugg');
    for (const [ic, text] of SUGGESTIONS) {
      const b = h('button', '', `${icon(ic, 16)}<span>${escHtml(text)}</span>`);
      b.addEventListener('click', () => { input.value = text; autosize(); updateSend(); input.focus(); });
      list.append(b);
    }
    e.append(list);
    return e;
  }

  function renderMsg(m) {
    if (m.role === 'user') {
      const d = h('div', 'm user');
      if (m.images?.length) {
        const imgs = h('div', 'imgs');
        for (const src of m.images) { const i = document.createElement('img'); i.src = src; i.alt = 'Immagine allegata'; imgs.append(i); }
        d.append(imgs);
      }
      d.append(document.createTextNode(m.text));
      if (m.element) {
        const el = h('div', 'el', `${icon('pointer', 13)}<span></span>`);
        el.querySelector('span').textContent = m.element;
        d.append(el);
      }
      return d;
    }
    if (m.role === 'ai') {
      const d = h('div', 'm ai');
      const body = h('div', 'md', MD.render(m.text));
      body.querySelectorAll('pre').forEach((pre) => {
        const b = h('button', 'cp', icon('copy', 14));
        b.setAttribute('aria-label', 'Copia codice');
        b.dataset.copy = 'code';
        pre.append(b);
      });
      d.append(body);
      if (m.steps?.length) {
        const det = h('details', 'steps');
        det.innerHTML = `<summary>${m.steps.length} passaggi ${icon('chevron-down', 13)}</summary><ol></ol>`;
        for (const s of m.steps) { const li = document.createElement('li'); li.textContent = s; det.querySelector('ol').append(li); }
        d.append(det);
      }
      const foot = h('div', 'foot', `<span></span><span class="sp"></span>`);
      foot.firstChild.textContent = m.meta || '';
      const cp = h('button', 'ib', icon('copy', 14));
      cp.setAttribute('aria-label', 'Copia risposta');
      cp.title = 'Copia risposta';
      cp.dataset.copy = 'msg';
      cp.dataset.text = m.text;
      foot.append(cp);
      d.append(foot);
      return d;
    }
    if (m.role === 'error') {
      const d = h('div', 'm error', `${icon('alert-triangle', 16)}<div></div>`);
      d.querySelector('div').textContent = m.text;
      return d;
    }
    const d = h('div', 'm note', `${icon('check', 14)}<span></span>`);
    d.querySelector('span').textContent = m.text;
    return d;
  }

  let timerEl = null;
  function renderActivity() {
    const a = state.activity;
    const d = h('div', 'm act');
    d.innerHTML = `<div class="top"><span class="dot"></span><span>Claude sta lavorando</span><span class="t"></span></div><ol></ol>`;
    timerEl = d.querySelector('.t');
    tick();
    const ol = d.querySelector('ol');
    const steps = a.steps.slice(-5);
    steps.forEach((s, i) => {
      const li = h('li', i === steps.length - 1 ? 'now' : '', `${icon(i === steps.length - 1 ? 'pointer' : 'check', 13)}<span></span>`);
      li.querySelector('span').textContent = s;
      ol.append(li);
    });
    if (!a.steps.length) d.append(h('div', 'shimmer'));
    return d;
  }
  function tick() {
    if (!timerEl || !state.activity) return;
    const s = Math.floor((Date.now() - state.activity.startedAt) / 1000);
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  setInterval(tick, 1000);

  let seen = 0; // messages already shown once (only new ones animate in)
  let activityShown = false;
  function render() {
    if (!state.open) return;
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
    logEl.textContent = '';
    seen = Math.min(seen, state.chat.length);
    if (!state.chat.length && !state.activity) logEl.append(renderEmpty());
    state.chat.forEach((m, i) => {
      const el = renderMsg(m);
      if (i >= seen) el.classList.add('fresh');
      logEl.append(el);
    });
    seen = state.chat.length;
    if (state.activity) {
      const el = renderActivity();
      if (!activityShown) el.classList.add('fresh');
      activityShown = true;
      logEl.append(el);
    } else activityShown = false;
    if (nearBottom || state.activity) logEl.scrollTop = logEl.scrollHeight;
  }

  logEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const text = b.dataset.copy === 'code' ? b.closest('pre').querySelector('code').textContent : b.dataset.text;
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const prev = b.innerHTML;
    b.innerHTML = icon('check', 14);
    setTimeout(() => { b.innerHTML = prev; }, 1200);
  });

  // ---------------------------------------------------------------------------
  // Health, features sheet, header actions
  // ---------------------------------------------------------------------------
  async function refreshHealth() {
    const hlt = await chrome.runtime.sendMessage({ type: 'health', host: HOST }).catch(() => null);
    state.health = hlt;
    const notes = [];
    if (hlt && !hlt.server) notes.push('Server locale spento. Avvialo con <code>node server/server.mjs</code> nella cartella webverse.');
    if (hlt && !hlt.userScripts) notes.push('Le modifiche JavaScript sono ferme: attiva "Allow User Scripts" nei dettagli dell\'estensione su chrome://extensions. Il CSS funziona comunque.');
    if (hlt && !hlt.enabled) notes.push('Modifiche disattivate su questo sito. Riattivale con il tasto di accensione in alto.');
    banner.innerHTML = notes.length ? `${icon('alert-triangle', 16)}<div>${notes.join('<br>')}</div>` : '';
    banner.hidden = !notes.length;
    const n = hlt?.features?.length || 0;
    const feat = $('.feat');
    feat.querySelector('span').textContent = String(n);
    feat.classList.toggle('on', n > 0 && hlt?.enabled !== false);
    feat.title = n ? `${n} modifiche attive` : 'Nessuna modifica su questo sito';
    countEl.hidden = !n || hlt?.enabled === false;
    countEl.textContent = String(n);
    $('[data-act="toggle"]').classList.toggle('off', !!hlt && !hlt.enabled);
    if (!sheet.hidden) renderSheet();
  }

  function renderSheet() {
    const f = state.health?.features || [];
    sheet.innerHTML = `<h3>Modifiche attive su ${escHtml(HOST)}</h3>`;
    if (!f.length) { sheet.append(h('div', 'none', 'Ancora nessuna. Chiedi qualcosa qui sotto.')); return; }
    for (const x of f) {
      const row = h('div', 'row', `<span class="name"></span>${x.kinds.map((k) => `<span class="tag">${k}</span>`).join('')}<button class="rm">Rimuovi</button>`);
      row.querySelector('.name').textContent = x.name;
      row.querySelector('.rm').addEventListener('click', () => {
        input.value = `Rimuovi la funzione "${x.name}".`;
        autosize(); updateSend(); input.focus();
        sheet.hidden = true;
      });
      sheet.append(row);
    }
  }

  async function act(name) {
    menu.hidden = true;
    switch (name) {
      case 'close': return setOpen(false);
      case 'menu': menu.hidden = !menu.hidden; return;
      case 'features': sheet.hidden = !sheet.hidden; if (!sheet.hidden) renderSheet(); return;
      case 'wide': return setWide(!state.wide);
      case 'hide': setOpen(false); return setVisible(false);
      case 'new': {
        state.chat = [];
        saveChat();
        render();
        const r = await chrome.runtime.sendMessage({ type: 'resetSession', host: HOST }).catch(() => null);
        if (r?.error) push({ role: 'error', text: r.error });
        return;
      }
    }
    if (state.busy) return;
    const type = { toggle: 'toggleMods', undo: 'undo', pull: 'pull' }[name];
    if (!type) return;
    const r = await chrome.runtime.sendMessage({ type, host: HOST }).catch((err) => ({ error: err.message }));
    if (r?.error) return push({ role: 'error', text: r.error });
    if (name === 'undo') push(r.changed
      ? { role: 'note', text: `Ultima modifica annullata. Ricarico la pagina.`, reload: true }
      : { role: 'note', text: 'Niente da annullare.' });
    if (name === 'toggle') push({ role: 'note', text: r.enabled ? 'Modifiche attivate. Ricarico la pagina.' : 'Modifiche disattivate. Ricarico la pagina.', reload: true });
    if (name === 'pull') push({ role: 'note', text: 'Modifiche ricaricate da disco. Ricarico la pagina.', reload: true });
  }

  shadow.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act);
    else if (!e.target.closest('.menu')) menu.hidden = true;
  });

  // ---------------------------------------------------------------------------
  // Composer: autosize, chips, attachments
  // ---------------------------------------------------------------------------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }
  function updateSend() {
    if (state.busy) {
      sendBtn.disabled = false;
      sendBtn.classList.add('stop');
      sendBtn.innerHTML = icon('player-stop', 16);
      sendBtn.setAttribute('aria-label', 'Interrompi');
      sendBtn.title = 'Interrompi';
      return;
    }
    sendBtn.classList.remove('stop');
    sendBtn.innerHTML = icon('arrow-up');
    sendBtn.setAttribute('aria-label', 'Invia');
    sendBtn.title = 'Invia (Invio)';
    sendBtn.disabled = !input.value.trim() && !state.attachments.length;
  }
  input.addEventListener('input', () => { autosize(); updateSend(); });

  function renderChips() {
    chipsEl.textContent = '';
    if (state.element) {
      const c = h('span', 'chip', `${icon('pointer', 13)}<span></span><button aria-label="Rimuovi elemento">${icon('x', 12)}</button>`);
      c.querySelector('span').textContent = state.element.selector;
      c.title = state.element.selector;
      c.querySelector('button').addEventListener('click', () => { state.element = null; renderChips(); });
      chipsEl.append(c);
    }
    state.attachments.forEach((a, i) => {
      const t = h('div', 'thumb', `<img alt=""><button aria-label="Rimuovi immagine">${icon('x', 11)}</button>`);
      t.querySelector('img').src = a.thumb;
      t.title = a.name;
      t.querySelector('button').addEventListener('click', () => { state.attachments.splice(i, 1); renderChips(); updateSend(); });
      chipsEl.append(t);
    });
    chipsEl.hidden = !state.element && !state.attachments.length;
    updateSend();
  }

  const MAX_ATT = 6;
  const MAX_DIM = 2000;
  const readFile = (blob) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: head.match(/data:([^;]+)/)?.[1] || 'image/png' });
  }
  async function resize(bmp, maxDim, quality) {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return readFile(await c.convertToBlob({ type: 'image/jpeg', quality }));
  }
  async function addAttachment(dataUrl, name) {
    if (state.attachments.length >= MAX_ATT) return push({ role: 'error', text: `Puoi allegare al massimo ${MAX_ATT} immagini per messaggio.` });
    try {
      const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
      const small = Math.max(bmp.width, bmp.height) <= MAX_DIM && dataUrl.length < 3_000_000 && /^data:image\/(png|jpeg|gif|webp)/.test(dataUrl);
      const full = small ? dataUrl : await resize(bmp, MAX_DIM, 0.85);
      const thumb = await resize(bmp, 160, 0.7);
      state.attachments.push({ dataUrl: full, thumb, name });
      renderChips();
    } catch {
      push({ role: 'error', text: `Immagine non leggibile: ${name}` });
    }
  }
  async function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const d = await readFile(f);
      if (d) await addAttachment(d, f.name || 'immagine');
    }
  }

  async function captureClean() {
    rootHost.style.visibility = 'hidden';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shot = await chrome.runtime.sendMessage({ type: 'capture' }).catch(() => null);
    rootHost.style.visibility = '';
    return shot?.dataUrl || null;
  }

  $('.bar').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-att]')?.dataset.att;
    if (a === 'file') fileInput.click();
    if (a === 'pick') startPick();
    if (a === 'shot') {
      const d = await captureClean();
      if (d) await addAttachment(d, `Screenshot ${new Date().toLocaleTimeString()}`);
      else push({ role: 'error', text: 'Screenshot non riuscito. Riprova dopo aver cliccato sulla pagina.' });
    }
  });
  fileInput.addEventListener('change', async () => { await addFiles([...fileInput.files]); fileInput.value = ''; });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
  panel.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    box.classList.add('drop');
  });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) box.classList.remove('drop'); });
  panel.addEventListener('drop', (e) => {
    box.classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  // keep the site's keyboard shortcuts away while typing in the widget
  for (const t of ['keydown', 'keyup', 'keypress']) shadow.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  shadow.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) menu.hidden = true;
    else if (!sheet.hidden) sheet.hidden = true;
    else setOpen(false);
  });
  sendBtn.addEventListener('click', () => (state.busy ? cancel() : submit()));

  // ---------------------------------------------------------------------------
  // Element picker
  // ---------------------------------------------------------------------------
  let pickTarget = null;
  const underPointer = (x, y) => {
    rootHost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    rootHost.style.pointerEvents = '';
    return el === rootHost ? null : el;
  };
  function onPickMove(e) {
    const el = underPointer(e.clientX, e.clientY);
    if (!el || el === pickTarget) return;
    pickTarget = el;
    const r = el.getBoundingClientRect();
    Object.assign(pickBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    pickTag.textContent = shortLabel(el);
    const tagTop = r.top > 30 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26);
    Object.assign(pickTag.style, { left: Math.max(4, Math.min(r.left, innerWidth - 300)) + 'px', top: tagTop + 'px' });
  }
  const swallow = (e) => {
    if (e.composedPath().includes(rootHost)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  function onPickClick(e) {
    if (e.composedPath().includes(rootHost)) return;
    swallow(e);
    const el = pickTarget || underPointer(e.clientX, e.clientY);
    stopPick();
    if (!el) return;
    state.element = { selector: cssPath(el), html: serialize(el, 40_000) };
    renderChips();
    input.focus();
  }
  function onPickKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopPick(); } }
  function startPick() {
    if (state.picking) return stopPick();
    state.picking = true;
    pickTarget = null;
    pickLayer.hidden = false;
    pickBox.style.width = '0';
    $('[data-att="pick"]').classList.add('active');
    panel.style.opacity = '.35';
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.addEventListener(t, swallow, true);
    document.addEventListener('keydown', onPickKey, true);
  }
  function stopPick() {
    state.picking = false;
    pickLayer.hidden = true;
    $('[data-att="pick"]').classList.remove('active');
    panel.style.opacity = '';
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.removeEventListener(t, swallow, true);
    document.removeEventListener('keydown', onPickKey, true);
  }
  pickLayer.addEventListener('click', (e) => { if (e.target.closest('[data-act="pick-cancel"]')) { e.stopPropagation(); stopPick(); } });

  // ---------------------------------------------------------------------------
  // Send / stream
  // ---------------------------------------------------------------------------
  function setBusy(v) {
    state.busy = v;
    bubble.classList.toggle('busy', v);
    $('[data-act="undo"]').disabled = v;
    $('[data-act="toggle"]').disabled = v;
    if (!v) state.activity = null;
    updateSend();
    render();
  }

  function cancel() {
    try { port?.postMessage({ type: 'cancel' }); } catch {}
  }

  async function submit() {
    if (state.busy) return;
    let text = input.value.trim();
    if (!text && !state.attachments.length) return;
    if (!text) text = 'Guarda le immagini allegate.';
    const imgs = state.attachments;
    const element = state.element;
    input.value = '';
    autosize();
    state.attachments = [];
    state.element = null;
    renderChips();
    sheet.hidden = true;

    push({ role: 'user', text, images: imgs.map((a) => a.thumb), element: element?.selector });
    state.activity = { startedAt: Date.now(), steps: [] };
    setBusy(true);

    const screenshot = await captureClean();
    const payload = {
      host: HOST,
      url: location.href,
      title: document.title,
      message: text,
      snapshot: snapshotPage(),
      screenshot,
      images: imgs.map(({ dataUrl, name }) => ({ dataUrl, name })),
      element,
    };

    port = chrome.runtime.connect({ name: 'ask' });
    let result = null;
    const finish = () => { try { port.disconnect(); } catch {} port = null; setBusy(false); refreshHealth(); };
    port.onMessage.addListener((ev) => {
      const a = state.activity;
      switch (ev.type) {
        case 'status':
          if (a) { a.steps.push(ev.text.replace(/…$/, '')); render(); }
          break;
        case 'result': {
          const secs = ev.durationMs ? Math.round(ev.durationMs / 1000) : null;
          const meta = [secs != null && `${secs}s`, ev.costUsd && `$${ev.costUsd.toFixed(3)}`].filter(Boolean).join('  ·  ');
          result = { role: ev.isError ? 'error' : 'ai', text: ev.text || 'Nessuna risposta.', meta, steps: a?.steps.filter((s) => !/^Claude sta/.test(s)) };
          break;
        }
        case 'applied':
          if (result) state.chat.push({ at: Date.now(), ...result });
          push({ role: 'note', text: 'Modifiche applicate. Ricarico la pagina.', reload: true });
          finish();
          break;
        case 'finished':
          if (result) push(result);
          finish();
          break;
        case 'cancelled':
          push({ role: 'note', text: 'Richiesta interrotta. Nessuna modifica applicata.' });
          finish();
          break;
        case 'error':
          if (result) state.chat.push({ at: Date.now(), ...result });
          push({ role: 'error', text: ev.text });
          finish();
          break;
      }
    });
    port.onDisconnect.addListener(() => { if (state.busy) { port = null; setBusy(false); } });
    port.postMessage(payload);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toggleWidget') {
      if (!state.visible) { setVisible(true); setOpen(true); }
      else if (state.open) { setOpen(false); setVisible(false); }
      else setOpen(true);
    }
    if (msg.type === 'openWidget') { setVisible(true); setOpen(true); }
    if (msg.type === 'pickElement' && contextTarget) {
      const el = contextTarget.nodeType === 1 ? contextTarget : contextTarget.parentElement;
      state.element = { selector: cssPath(el), html: serialize(el, 40_000) };
      setVisible(true);
      setOpen(true);
      renderChips();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.wvVisible) { state.visible = changes.wvVisible.newValue !== false; place(); }
    if (changes.wvCorner) { state.corner = changes.wvCorner.newValue || 'br'; place(); }
  });

  chrome.storage.local.get(['wvCorner', 'wvVisible', 'wvWide', CHAT_KEY]).then((s) => {
    state.corner = s.wvCorner || 'br';
    state.visible = s.wvVisible !== false;
    state.chat = (s[CHAT_KEY] || []).filter((m) => m.role !== 'status');
    document.documentElement.appendChild(rootHost);
    place();
    if (s.wvWide) setWide(true);
    updateSend();
    refreshHealth();
    // reopen after an auto-reload triggered by an applied change
    const last = state.chat[state.chat.length - 1];
    if (last?.reload && Date.now() - last.at < 15000) setOpen(true);
  });
})();
