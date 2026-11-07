# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this repository. Two kinds of task come up: **setting Webverse up for a user**, and **changing the code**. Read the matching section.

## What this project is

A Chrome MV3 extension (`extension/`) plus a dependency-free Node server (`server/server.mjs`). The extension shows a chat widget on every page; the server receives the user's message with a DOM snapshot and screenshot, runs `claude -p` inside `sites/<host>/`, and Claude edits `mod.css` / `mod.js`, which the extension then injects into that site. See [README.md](README.md) for the full picture.

## Setting it up for a user

Do these steps in order and verify each one. Steps marked **(user)** happen in the Chrome UI: you cannot do them, so tell the user exactly what to click and wait for confirmation.

1. **Check prerequisites**
   ```sh
   node --version     # must be >= 20
   claude --version   # Claude Code must be installed
   claude -p "reply with ok" --output-format text   # must print a reply; if it fails, the user must log in by running `claude` once
   ```
   Do not install Node or Claude Code yourself with system package managers. If missing, tell the user what to install.

2. **Verify the code**
   ```sh
   npm run check      # syntax-checks every file, prints "ok"
   ```

3. **Start the server** (long-running; run it in the background or a separate terminal)
   ```sh
   npm start
   curl -s http://127.0.0.1:4317/health   # expect {"ok":true,...}
   ```
   If port 4317 is taken, set `WEBVERSE_PORT` and update `SERVER` at the top of `extension/background.js` to match.

4. **(user) Load the extension**: `chrome://extensions` › enable *Developer mode* › *Load unpacked* › select the absolute path of this repo's `extension/` folder (print it for them).

5. **(user) Allow user scripts**: on the Webverse card › *Details* › enable *Allow User Scripts*. Required on Chrome 138+ for JavaScript mods.

6. **(user) Reload open tabs**, open any site, click the round button bottom right and send a request.

Optional smoke test of the server without the browser (spends a few cents of Claude usage, uses a throwaway workspace):
```sh
WEBVERSE_SITES=/tmp/webverse-smoke WEBVERSE_PORT=4399 node server/server.mjs &
curl -sN -H 'content-type: application/json' localhost:4399/ask --data '{"host":"example.com","url":"https://example.com/","message":"Make the page background light yellow.","snapshot":"<html>\n  <body>\n    <h1>Example</h1>\n  </body>\n</html>"}'
# expect NDJSON lines ending with {"type":"done","changed":true,...}
kill %1
```

## Changing the code

### Ground rules

- **No dependencies, no build step.** The extension is loaded unpacked as-is; the server uses only Node built-ins. Do not add npm packages, bundlers or TypeScript without the maintainer asking for it.
- **Never commit `sites/`.** It contains the user's page snapshots, screenshots, attachments and Claude session ids. It is git-ignored; keep it so.
- Run `npm run check` after every change.
- After changing the extension, the user must press reload on the extension card in `chrome://extensions` and reload the tab. After changing the server, restart it.

### Map

| File | Responsibility |
| --- | --- |
| `extension/background.js` | Service worker. Streams `/ask` from the server back to the tab over a port, stores mods in `chrome.storage.local` (`sites` key), injects CSS on `webNavigation.onCommitted` with `origin: 'USER'`, registers `chrome.userScripts` (prelude + mod.js), context menu, action click, keyboard command. |
| `extension/content.js` | The widget in a **closed** shadow root: chat, composer, attachments, element picker, DOM snapshot serializer (`serialize`), CSS path builder (`cssPath`). All UI tokens are CSS variables on `:host` with a dark-mode override. |
| `extension/prelude.js` | The `wv` helper object available to every `mod.js` (observe, onNavigate, addStyle, el, toast, copy). If you change its API, update `server/system-prompt.md` too. |
| `extension/markdown.js` | Safe Markdown renderer (escapes first, then emits a fixed tag set). Keep it XSS-safe: never pass raw HTML through. |
| `extension/icons.js` | Vendored Tabler icon paths. Add icons by copying the inner SVG markup from `@tabler/icons` (outline set). Do not hand-draw icons. |
| `server/server.mjs` | HTTP API: `POST /ask` (NDJSON stream), `POST /undo`, `POST /reset`, `GET /mods`, `GET /health`. Spawns `claude -p --output-format stream-json` with restricted tools and `--append-system-prompt-file`. |
| `server/system-prompt.md` | The contract Claude follows when writing mods (file rules, selector strategy, `wv` API, safety). |

### Invariants worth knowing

- `mod.css` is a USER-origin stylesheet: declarations only win with `!important`.
- `mod.js` runs once per full page load in the `USER_SCRIPT` world. Sites like LinkedIn are SPAs, so mods must use `wv.observe` / `wv.onNavigate` and be idempotent.
- Features inside mods are delimited by `== feature: <name> ==` comments. The widget's "active changes" list parses them; keep that convention in the system prompt.
- The server's security model: bind `127.0.0.1`, reject non-extension `Origin`, reject non-localhost `Host`, no Bash/WebFetch for Claude. Don't weaken these.
- Page content in the snapshot is untrusted (other people's posts). Anything that feeds it to the model must keep treating it as data.
- Cancelling a request (`cancel` over the port) aborts the fetch; the server kills `claude` and rolls back half-written mod files.

### Testing UI changes without Chrome extension APIs

The widget only needs a handful of `chrome.*` calls. A quick way to look at it: serve a static HTML page that defines a stub `window.chrome` (storage get/set, runtime.onMessage/sendMessage/connect), loads `icons.js`, `markdown.js`, `content.js`, then triggers the stored `onMessage` listener with `{ type: 'openWidget' }`. Screenshot it in light and dark color schemes.
