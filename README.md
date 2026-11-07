# Webverse

Reshape any website by talking to it.

Webverse is a Chrome extension that puts a small AI assistant on every page. You tell it what bothers you ("hide the suggested posts", "add a button that copies my profile URL", "autocomplete emoji when I type `:`", "a soft dark theme") and a **local** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) writes the CSS and JavaScript that make it so. The changes stick: every time you come back to that site, your version loads.

It is meant for personal, local use. Nothing leaves your machine except what Claude Code itself sends to Anthropic.

## How it works

```
 page ── widget (content.js) ──port──▶ background.js ──HTTP──▶ server/server.mjs  (127.0.0.1:4317)
          DOM snapshot, screenshot,                                │
          your message, images                                     ▼
                                          claude -p   (cwd: sites/<host>/, tools: Read/Edit/Write/Glob/Grep)
                                                                   │  edits mod.css / mod.js
 page reloads ◀── chrome.storage + userScripts ◀───────────────────┘
```

- `sites/<host>/mod.css` is injected as a **user stylesheet** on every navigation, so it wins over the site's own styles (with `!important`).
- `sites/<host>/mod.js` is registered with the `chrome.userScripts` API, which runs in an isolated world and is not blocked by the site's Content Security Policy. It gets a small helper library, `wv` ([extension/prelude.js](extension/prelude.js)), built for single-page apps.
- Each site has its own Claude session (`--resume`), so the conversation carries over between requests.
- Before every change the previous version is saved in `sites/<host>/history/`. The undo button restores it.
- The files in `sites/` are the source of truth. Edit them by hand if you like, then use "Reload changes from disk" in the widget menu.

## Requirements

- Chrome (or another Chromium browser) 120+. Chrome 138+ needs the per-extension **Allow User Scripts** toggle (see below).
- Node.js 20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, on your `PATH` as `claude`, and logged in (`claude` once interactively).

No `npm install`: there are no dependencies and no build step.

## Install

> Using an AI coding agent? Point it at this repo and ask it to "set up Webverse for me". [AGENTS.md](AGENTS.md) has the exact steps it should follow.

1. **Clone and start the local server**
   ```sh
   git clone https://github.com/davide97g/webverse.git
   cd webverse
   npm start            # same as: node server/server.mjs
   ```
   Check it: `curl http://127.0.0.1:4317/health` should return `{"ok":true,...}`.

2. **Load the extension**
   Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the `extension/` folder.

3. **Allow user scripts**
   On the Webverse card click **Details** and turn on **Allow User Scripts**. Without it, only CSS changes apply (the widget tells you).

4. **Reload** any tab that was already open.

## Use

| Action | How |
| --- | --- |
| Open the assistant | Click the round button (bottom right), the toolbar icon, or press `Alt+Shift+W` |
| Move it | Drag the button to any corner |
| Point at an element | Pointer icon in the composer, then click the element (Esc cancels). Or right click › *Webverse: modifica questo elemento* |
| Attach images | Camera icon (screenshot of the page without the widget), paperclip, paste, or drag and drop |
| See what is active | The counter in the header lists every feature added to this site, with a shortcut to remove one |
| Undo / turn off | Undo arrow, power button |
| More | `⋯` menu: large panel, new conversation, reload changes from disk, hide the button |

Example requests that work well:

- "Hide the right sidebar and make the feed wider."
- "Add a 'Copy profile URL' button next to my name."
- "When I type `:smile` in a post, show an emoji autocomplete."
- "Dark theme with a single cobalt accent, keep images untouched."

The UI text is in Italian for now. Claude replies in the language you write in.

## Configuration

Environment variables for `npm start`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBVERSE_PORT` | `4317` | Server port. If you change it, also change `SERVER` at the top of `extension/background.js`. |
| `WEBVERSE_MODEL` | Claude Code default | Model for `claude -p`, e.g. `sonnet` (faster) or `opus`. |
| `WEBVERSE_SITES` | `./sites` | Where per-site workspaces live. |
| `WEBVERSE_CLAUDE` | `claude` | Path to the Claude Code binary. |
| `WEBVERSE_TIMEOUT_MS` | `600000` | Max time for one request. |

## Project layout

```
extension/
  manifest.json      MV3 manifest
  background.js      service worker: talks to the server, stores mods, injects CSS, registers user scripts
  content.js         the widget (shadow DOM), DOM snapshot, element picker
  prelude.js         `wv` helpers available to every mod.js
  markdown.js        tiny safe Markdown renderer for chat messages
  icons.js           vendored Tabler icons
server/
  server.mjs         local HTTP bridge to `claude -p`
  system-prompt.md   rules Claude follows when writing mods
sites/               your per-site workspaces (git-ignored, personal)
```

## Security and privacy

- The server listens on `127.0.0.1` only, rejects requests whose `Origin` is a web page (only `chrome-extension://` or no origin is accepted) and whose `Host` is not localhost.
- Claude runs with `Read, Edit, Write, Glob, Grep` only (no shell, no web access), in `acceptEdits` mode, inside `sites/<host>/`.
- **The page snapshot contains text written by other people** (posts, comments, messages). The system prompt tells Claude to treat it as data, but prompt injection cannot be ruled out completely, and the generated JavaScript runs with your logged-in session on that site. On sensitive sites, read `mod.js` after changes.
- `sites/` holds snapshots and screenshots of pages you visited. It is git-ignored; keep it that way.
- Snapshots, screenshots and your messages are sent to Anthropic by Claude Code, under your Claude Code account and its terms.

## Troubleshooting

- **"Server locale spento"** in the widget: the server is not running. Run `npm start` in the repo.
- **CSS applies but JS does not**: enable *Allow User Scripts* (step 3), then reload the tab.
- **Nothing appears on a tab**: tabs opened before the extension was loaded need a reload. Chrome pages (`chrome://`, the Web Store) cannot be modified.
- **A change broke the site**: undo arrow, or the power button to turn all changes off for that site.
- **Requests fail immediately**: run `claude -p "hi"` in a terminal to check Claude Code is installed and logged in. Server logs are printed by `npm start`.

## License

MIT. Icons from [Tabler Icons](https://tabler.io/icons) (MIT).
