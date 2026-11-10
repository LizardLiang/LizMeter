# Pipe equivalence harness

Proves the native pipe server (`native/crates/services/src/pipe.rs`) answers like the Electron one
(`electron/main/pipe-server.ts`): the same request script goes to each server and the raw reply
lines are compared byte for byte, after masking timestamps and uuids.

**Pipe safety.** The installed app owns the default pipe `\\.\pipe\lizmeter`. Every script here
refuses that path (and `lizmeter-dev`). Run everything on a unique test path.

## Run

1. Node-ABI better-sqlite3 in a scratch folder (the repo copy is built for Electron):
   `bun add better-sqlite3@<repo version>` there, then run `bunx prebuild-install` inside
   `node_modules/better-sqlite3`.
2. Electron side (the real `pipe-server.ts` over a scratch database):
   `LIZMETER_EQUIV_DIR=<that folder> LIZMETER_PIPE_PATH=<test pipe> node native/tools/pipe-equivalence/electron-serve.mjs`
3. Native side: `cargo run -p lizmeter-services --example pipe_serve -- <scratch data dir> <test pipe>`
4. For each server: `node run-script.mjs <test pipe> <out.jsonl>`, then
   `node compare.mjs electron.jsonl native.jsonl`. Both servers must start from an empty database.
5. MCP level: `node mcp-smoke.mjs <test pipe> out.txt` runs `mcp/lizmeter-todo-mcp.mjs` unchanged
   against a server and writes every tool call with its reply; diff the two outputs.

In Git Bash, build the `\\.\pipe\...` value with `printf '\x5c\x5c.\x5cpipe\x5c<name>'` and set
`MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' MSYS2_ENV_CONV_EXCL='*'`, or the shell rewrites it.

## What the script covers

179 steps: framing (ids of every JSON kind, no id, malformed JSON, scalars, arrays), the legacy
Neovim shape, every command with valid and invalid fields, paging, the stale-write guard, the
confirm-title delete, all nine taxonomy writes, several lines per connection, a message split across
writes and across a multi-byte character, a trailing line with no newline, and an oversized message
(limit reply, then close).
