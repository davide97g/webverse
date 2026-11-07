const SERVER = 'http://127.0.0.1:4317';

const hostKey = (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
};

const scriptId = (host) => 'wv_' + host.replace(/[^a-z0-9]/gi, '_');

async function getSites() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites;
}

// "linkedin.com" mods also apply to "de.linkedin.com" etc.
function findSite(sites, host) {
  if (!host) return null;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(i).join('.');
    if (sites[key]) return { key, ...sites[key] };
  }
  return null;
}

function userScriptsAvailable() {
  try { return !!chrome.userScripts && typeof chrome.userScripts.getScripts === 'function'; }
  catch { return false; }
}

async function syncUserScripts() {
  if (!userScriptsAvailable()) return false;
  try {
    const sites = await getSites();
    const existing = await chrome.userScripts.getScripts();
    if (existing.length) await chrome.userScripts.unregister({ ids: existing.map((s) => s.id) });
    const scripts = Object.entries(sites)
      .filter(([, s]) => s.enabled !== false && s.js && s.js.trim())
      .map(([host, s]) => ({
        id: scriptId(host),
        matches: [`*://${host}/*`, `*://*.${host}/*`],
        js: [{ file: 'prelude.js' }, { code: `try {\n${s.js}\n} catch (e) { console.error('[webverse] mod.js', e); }` }],
        runAt: 'document_idle',
        world: 'USER_SCRIPT',
      }));
    if (scripts.length) await chrome.userScripts.register(scripts);
    return true;
  } catch (e) {
    console.error('[webverse] userScripts sync failed', e);
    return false;
  }
}

async function saveMod(host, { css, js }) {
  const sites = await getSites();
  const old = sites[host] || {};
  sites[host] = { ...old, css: css ?? '', js: js ?? '', enabled: old.enabled ?? true, updatedAt: Date.now() };
  await chrome.storage.local.set({ sites });
  await syncUserScripts();
}

async function pullFromDisk() {
  try {
    const res = await fetch(SERVER + '/mods');
    if (!res.ok) return false;
    const disk = await res.json();
    const sites = await getSites();
    for (const [host, m] of Object.entries(disk)) {
      if (!m.css.trim() && !m.js.trim() && !sites[host]) continue;
      sites[host] = { ...(sites[host] || { enabled: true }), css: m.css, js: m.js, updatedAt: Date.now() };
    }
    await chrome.storage.local.set({ sites });
    await syncUserScripts();
    return true;
  } catch { return false; }
}

async function injectCss(tabId, url) {
  const site = findSite(await getSites(), hostKey(url));
  if (!site || site.enabled === false || !site.css || !site.css.trim()) return;
  chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, css: site.css, origin: 'USER' }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0) injectCss(tabId, url);
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'wv-element', title: 'Webverse: modifica questo elemento', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'wv-open', title: 'Webverse: apri assistente', contexts: ['all'] });
  });
}

chrome.runtime.onInstalled.addListener(() => { setupMenus(); pullFromDisk().then((ok) => ok || syncUserScripts()); });
chrome.runtime.onStartup.addListener(() => { pullFromDisk().then((ok) => ok || syncUserScripts()); });

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    // tab opened before the extension was (re)loaded: inject and retry
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['icons.js', 'markdown.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

chrome.action.onClicked.addListener((tab) => sendToTab(tab.id, { type: 'toggleWidget' }).catch(() => {}));
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'toggle-widget') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) sendToTab(tab.id, { type: 'toggleWidget' }).catch(() => {});
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const type = info.menuItemId === 'wv-element' && info.frameId === 0 ? 'pickElement' : 'openWidget';
  sendToTab(tab.id, { type }).catch(() => {});
});

async function serverPost(pathname, body) {
  const res = await fetch(SERVER + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const friendly = (e) => (/Failed to fetch|NetworkError/i.test(e.message)
  ? 'Server locale non raggiungibile. Avvialo con: node server/server.mjs'
  : e.message);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  (async () => {
    switch (msg.type) {
      case 'capture': {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 70 });
        return { dataUrl };
      }
      case 'health': {
        let server = false;
        try { server = (await fetch(SERVER + '/health')).ok; } catch {}
        const site = findSite(await getSites(), msg.host);
        const features = [];
        for (const [kind, src] of [['css', site?.css], ['js', site?.js]]) {
          for (const m of String(src || '').matchAll(/==\s*feature:\s*(.+?)\s*==/g)) {
            const name = m[1].trim();
            const f = features.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (f) f.kinds.push(kind); else features.push({ name, kinds: [kind] });
          }
        }
        return {
          server,
          userScripts: userScriptsAvailable(),
          hasJs: !!site?.js?.trim(),
          enabled: site ? site.enabled !== false : true,
          features,
        };
      }
      case 'toggleMods': {
        const sites = await getSites();
        const site = findSite(sites, msg.host);
        if (!site) return { enabled: true };
        sites[site.key].enabled = site.enabled === false;
        await chrome.storage.local.set({ sites });
        await syncUserScripts();
        setTimeout(() => chrome.tabs.reload(tabId), 300);
        return { enabled: sites[site.key].enabled };
      }
      case 'undo': {
        const r = await serverPost('/undo', { host: msg.host });
        if (r.changed) {
          await saveMod(msg.host, r);
          setTimeout(() => chrome.tabs.reload(tabId), 300);
        }
        return r;
      }
      case 'resetSession':
        return serverPost('/reset', { host: msg.host });
      case 'pull': {
        const ok = await pullFromDisk();
        if (!ok) throw new Error('Server locale non raggiungibile.');
        setTimeout(() => chrome.tabs.reload(tabId), 300);
        return { ok };
      }
    }
  })().then(sendResponse, (e) => sendResponse({ error: friendly(e) }));
  return true;
});

// Long-running request: content script opens a port, we stream server events back on it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ask') return;
  const tabId = port.sender?.tab?.id;
  let alive = true;
  port.onDisconnect.addListener(() => { alive = false; });
  const post = (m) => { if (alive) try { port.postMessage(m); } catch { alive = false; } };
  const ac = new AbortController();
  port.onMessage.addListener((msg) => {
    if (msg.type === 'cancel') ac.abort();
    else runAsk(msg, post, tabId, ac.signal);
  });
});

async function runAsk(payload, post, tabId, signal) {
  // keep the service worker alive while the (long) fetch stream is open
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    const res = await fetch(SERVER + '/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'done') done = ev;
        else post(ev);
      }
    }
    if (done?.changed) {
      await saveMod(payload.host, done);
      post({ type: 'applied' });
      setTimeout(() => chrome.tabs.reload(tabId), 700);
    } else {
      post({ type: 'finished' });
    }
  } catch (e) {
    if (e.name === 'AbortError') post({ type: 'cancelled' });
    else post({ type: 'error', text: friendly(e) });
  } finally {
    clearInterval(keepAlive);
  }
}
