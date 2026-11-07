// Helpers available to every site's mod.js as `wv`. Runs in the USER_SCRIPT world.
(() => {
  if (globalThis.wv) return;
  const MARK = 'data-wv-seen';
  const observers = [];
  let seq = 0;

  function scan(root, o) {
    const list = [];
    if (root.nodeType === 1 && root.matches?.(o.sel)) list.push(root);
    if (root.querySelectorAll) list.push(...root.querySelectorAll(o.sel));
    for (const el of list) {
      const seen = (el.getAttribute(MARK) || '').split(' ');
      if (seen.includes(o.id)) continue;
      el.setAttribute(MARK, [...seen.filter(Boolean), o.id].join(' '));
      try { o.fn(el); } catch (e) { console.error('[webverse] observe', o.sel, e); }
    }
  }

  let pending = false;
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const o of observers) scan(document, o);
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const navFns = [];
  let lastUrl = location.href;
  const checkNav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    for (const fn of navFns) { try { fn(lastUrl); } catch (e) { console.error('[webverse] onNavigate', e); } }
  };
  // History API patches don't reach the isolated world, so poll cheaply + listen to popstate.
  setInterval(checkNav, 400);
  addEventListener('popstate', checkNav);

  globalThis.wv = {
    observe(sel, fn) {
      const o = { sel, fn, id: 'o' + (++seq) };
      observers.push(o);
      scan(document, o);
      return () => observers.splice(observers.indexOf(o), 1);
    },
    onNavigate(fn) {
      navFns.push(fn);
      try { fn(location.href); } catch (e) { console.error('[webverse] onNavigate', e); }
    },
    addStyle(css) {
      const s = document.createElement('style');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
      return s;
    },
    el(tag, props = {}, ...children) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(props || {})) {
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
      }
      for (const c of children.flat()) if (c != null) el.append(c);
      return el;
    },
    toast(text, ms = 2200) {
      const t = document.createElement('div');
      t.textContent = text;
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;' +
        'background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .15s';
      document.documentElement.appendChild(t);
      requestAnimationFrame(() => { t.style.opacity = '1'; });
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, ms);
    },
    async copy(text) {
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.documentElement.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    },
  };
})();
