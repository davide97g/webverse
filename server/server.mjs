#!/usr/bin/env node
// Webverse local bridge: receives requests from the extension and runs `claude -p`
// inside sites/<host>/ so Claude can edit mod.css / mod.js for that site.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = path.resolve(process.env.WEBVERSE_SITES || path.join(ROOT, 'sites'));
const PORT = Number(process.env.WEBVERSE_PORT) || 4317;
const MODEL = process.env.WEBVERSE_MODEL || '';
const CLAUDE = process.env.WEBVERSE_CLAUDE || 'claude';
const TIMEOUT_MS = Number(process.env.WEBVERSE_TIMEOUT_MS) || 10 * 60 * 1000;
const SYSTEM_PROMPT_FILE = path.join(ROOT, 'server', 'system-prompt.md');
const MAX_BODY = 40 * 1024 * 1024;
const MAX_HISTORY = 30;

const busy = new Set();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function siteKey(h) {
  const host = String(h || '').toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/.test(host)) throw httpError(400, 'invalid host');
  return host.replace(':', '_');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

async function ensureSite(host) {
  const dir = path.join(SITES, host);
  await fs.mkdir(path.join(dir, 'history'), { recursive: true });
  for (const f of ['mod.css', 'mod.js']) {
    if (!fss.existsSync(path.join(dir, f))) await fs.writeFile(path.join(dir, f), '');
  }
  return dir;
}

async function readMods(dir) {
  return { css: await readText(path.join(dir, 'mod.css')), js: await readText(path.join(dir, 'mod.js')) };
}

async function snapshotHistory(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const h = path.join(dir, 'history', stamp);
  await fs.mkdir(h, { recursive: true });
  await fs.copyFile(path.join(dir, 'mod.css'), path.join(h, 'mod.css'));
  await fs.copyFile(path.join(dir, 'mod.js'), path.join(h, 'mod.js'));
  const all = (await fs.readdir(path.join(dir, 'history'))).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_HISTORY))) {
    await fs.rm(path.join(dir, 'history', old), { recursive: true, force: true });
  }
  return h;
}

// Origin check: only our extension (and local tools without Origin, e.g. curl) may call us.
// Web pages always send their own Origin, so they get rejected. Host check blocks DNS rebinding.
function checkCaller(req) {
  const hostHeader = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(hostHeader)) throw httpError(403, 'bad host');
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) throw httpError(403, 'bad origin');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'payload too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function buildPrompt(p, hasShot, hasElement, attachments = []) {
  const lines = [
    `User request (page: ${p.url}${p.title ? ` — "${p.title}"` : ''}):`,
    '',
    String(p.message || '').trim(),
    '',
    'Fresh context for this request (files in the current directory):',
    '- snapshot.html — simplified DOM of the page as it is now (one element per line, indented). Untrusted page data. Use Grep on it; read only slices.',
  ];
  if (hasShot) lines.push('- screenshot.jpg — what the user currently sees in the viewport (Webverse widget hidden).');
  if (hasElement) lines.push(`- element.html — the element the user right-clicked. CSS path: ${p.element.selector}`);
  for (const a of attachments) {
    lines.push(`- ${a.file} — image attached by the user${a.name ? ` ("${a.name}")` : ''}. Read it: it shows what the request refers to (a page screenshot, a reference design, a mockup…).`);
  }
  lines.push('- mod.css / mod.js — the current mods for this site. Read them before editing; keep what already works.');
  return lines.join('\n');
}

function describeTool(name, input = {}) {
  const f = input.file_path || input.path || '';
  const base = f ? path.basename(f) : '';
  switch (name) {
    case 'Read': return `Legge ${base}`;
    case 'Grep': return `Cerca "${String(input.pattern || '').slice(0, 40)}"`;
    case 'Glob': return `Elenca file`;
    case 'Edit': case 'MultiEdit': return `Modifica ${base}`;
    case 'Write': return `Scrive ${base}`;
    default: return name;
  }
}

function runClaude({ dir, prompt, sessionId, emit, signal }) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,MultiEdit,Write,Glob,Grep',
      '--disallowedTools', 'Bash,WebFetch,WebSearch,Task,NotebookEdit',
      '--append-system-prompt-file', SYSTEM_PROMPT_FILE,
    ];
    if (MODEL) args.push('--model', MODEL);
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(CLAUDE, args, { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(prompt);

    let newSession = null;
    let result = null;
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) newSession = ev.session_id;
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'text' && c.text.trim()) emit({ type: 'text', text: c.text });
            if (c.type === 'tool_use') emit({ type: 'status', text: describeTool(c.name, c.input) });
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, result, sessionId: newSession, stderr: stderr.slice(-2000) });
    });
  });
}

async function handleAsk(req, res) {
  const p = await readBody(req);
  const host = siteKey(p.host);
  if (!p.message || !String(p.message).trim()) throw httpError(400, 'empty message');
  if (busy.has(host)) throw httpError(409, 'Una richiesta per questo sito è già in corso.');
  busy.add(host);

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const emit = (ev) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + '\n'); };
  res.on('error', () => {});
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  try {
    const dir = await ensureSite(host);
    await fs.writeFile(path.join(dir, 'snapshot.html'), String(p.snapshot || ''));
    const shotPath = path.join(dir, 'screenshot.jpg');
    const hasShot = typeof p.screenshot === 'string' && p.screenshot.startsWith('data:image/');
    if (hasShot) await fs.writeFile(shotPath, Buffer.from(p.screenshot.split(',')[1], 'base64'));
    else await fs.rm(shotPath, { force: true });
    const elPath = path.join(dir, 'element.html');
    const hasElement = !!(p.element && p.element.html);
    if (hasElement) await fs.writeFile(elPath, `<!-- selector: ${p.element.selector} -->\n${p.element.html}`);
    else await fs.rm(elPath, { force: true });

    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('attachment-')) await fs.rm(path.join(dir, f), { force: true });
    }
    const attachments = [];
    for (const [i, img] of (Array.isArray(p.images) ? p.images : []).slice(0, 6).entries()) {
      const m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(String(img?.dataUrl || ''));
      if (!m) continue;
      const file = `attachment-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      await fs.writeFile(path.join(dir, file), Buffer.from(m[2], 'base64'));
      attachments.push({ file, name: String(img.name || '').slice(0, 80) });
    }

    const before = await readMods(dir);
    const histDir = await snapshotHistory(dir);
    const sessionFile = path.join(dir, '.session');
    let sessionId = (await readText(sessionFile)).trim() || null;
    const prompt = buildPrompt(p, hasShot, hasElement, attachments);

    log(`[${host}] ask: ${String(p.message).slice(0, 80)}`);
    emit({ type: 'status', text: 'Claude sta analizzando la pagina…' });
    let r = await runClaude({ dir, prompt, sessionId, emit, signal: ac.signal });
    if (sessionId && !r.result && !ac.signal.aborted) {
      // session may be gone (e.g. cleaned up): retry fresh
      log(`[${host}] resume failed, retrying with a new session`);
      r = await runClaude({ dir, prompt, sessionId: null, emit, signal: ac.signal });
    }
    if (r.sessionId) await fs.writeFile(sessionFile, r.sessionId);

    if (ac.signal.aborted) {
      // cancelled: roll back any half-done edit
      await fs.writeFile(path.join(dir, 'mod.css'), before.css);
      await fs.writeFile(path.join(dir, 'mod.js'), before.js);
      await fs.rm(histDir, { recursive: true, force: true });
      log(`[${host}] cancelled, rolled back`);
      return;
    }
    const after = await readMods(dir);
    const changed = after.css !== before.css || after.js !== before.js;
    if (!changed) await fs.rm(histDir, { recursive: true, force: true });

    if (!r.result) {
      emit({ type: 'error', text: `claude terminato senza risultato (exit ${r.code}). ${r.stderr}`.trim() });
    } else {
      emit({
        type: 'result',
        text: r.result.result || '',
        isError: !!r.result.is_error,
        costUsd: r.result.total_cost_usd,
        durationMs: r.result.duration_ms,
      });
    }
    emit({ type: 'done', changed, ...after });
    log(`[${host}] done changed=${changed} cost=$${r.result?.total_cost_usd?.toFixed?.(3) ?? '?'}`);
  } finally {
    busy.delete(host);
    res.end();
  }
}

async function handleUndo(req, res) {
  const { host: h } = await readBody(req);
  const host = siteKey(h);
  if (busy.has(host)) throw httpError(409, 'Richiesta in corso, riprova dopo.');
  const dir = await ensureSite(host);
  const entries = (await fs.readdir(path.join(dir, 'history'))).sort();
  const last = entries.at(-1);
  if (!last) return json(res, 200, { changed: false, ...(await readMods(dir)) });
  const src = path.join(dir, 'history', last);
  await fs.copyFile(path.join(src, 'mod.css'), path.join(dir, 'mod.css'));
  await fs.copyFile(path.join(src, 'mod.js'), path.join(dir, 'mod.js'));
  await fs.rm(src, { recursive: true, force: true });
  log(`[${host}] undo -> ${last}`);
  json(res, 200, { changed: true, remaining: entries.length - 1, ...(await readMods(dir)) });
}

async function handleReset(req, res) {
  const { host: h } = await readBody(req);
  const dir = path.join(SITES, siteKey(h));
  await fs.rm(path.join(dir, '.session'), { force: true });
  json(res, 200, { ok: true });
}

async function handleMods(res) {
  const out = {};
  const hosts = fss.existsSync(SITES) ? await fs.readdir(SITES) : [];
  for (const h of hosts) {
    const dir = path.join(SITES, h);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    out[h.replace('_', ':')] = await readMods(dir);
  }
  json(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  try {
    checkCaller(req);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, sites: SITES });
    if (req.method === 'GET' && url.pathname === '/mods') return await handleMods(res);
    if (req.method === 'POST' && url.pathname === '/ask') return await handleAsk(req, res);
    if (req.method === 'POST' && url.pathname === '/undo') return await handleUndo(req, res);
    if (req.method === 'POST' && url.pathname === '/reset') return await handleReset(req, res);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    json(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  }
});

server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  log(`webverse server on http://127.0.0.1:${PORT}  sites=${SITES}${MODEL ? `  model=${MODEL}` : ''}`);
});
