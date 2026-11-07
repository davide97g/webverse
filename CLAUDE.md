# CLAUDE.md

@AGENTS.md

## Notes for Claude Code

- When a user asks to "set up" or "install" Webverse, follow the setup section of AGENTS.md step by step and verify each step. Start the server with `run_in_background`, then hand the Chrome steps to the user with the absolute path of `extension/`.
- This repo is also the tool that runs Claude: `server/server.mjs` spawns `claude -p` in `sites/<host>/`. Those runs are separate sessions; don't confuse their workspaces with this repo, and never commit `sites/`.
- If you change the `wv` helper API in `extension/prelude.js`, update `server/system-prompt.md` in the same change.
