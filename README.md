# zwilling

A small local MCP server (stdio) that lets Claude Code consult Gemini for a second opinion, a code review, or reading many large files at once. Every exchange is appended to a markdown log in the project, so you and both agents can see what was said.

zwilling is a thin wrapper around the **Antigravity CLI** (`agy`), which replaces the deprecated Gemini CLI. It uses your existing `agy` sign-in. It holds no API keys and never calls a Gemini API directly.

Gemini runs **with no tool access**: it can't read or write files, run commands, or call MCP servers. It only sees the prompt and the file contents zwilling attaches after its own path checks. Claude Code stays the only agent that changes code.

## Requirements

- Node.js ≥ 20
- [Antigravity CLI](https://antigravity.google/download#antigravity-cli) on your `PATH` as `agy`, signed in (run `agy` once and follow the prompts)

## Install and build

```bash
git clone https://github.com/Cromewell/zwilling.git
cd zwilling
npm install      # .npmrc sets legacy-peer-deps (works around a Debian npm 9 bug)
npm run build    # compiles src/ to dist/
npm test         # builds, then runs the vitest suite against a fake agy
```

## Register with Claude Code

```bash
claude mcp add zwilling -s user -- node /absolute/path/to/zwilling/dist/index.js
claude mcp list   # should show: zwilling ... ✔ Connected
```

`-s user` makes it available in every project. Start a new Claude Code session afterwards so the tools load.

If Claude Code can't find `agy` (for example because it was started from a launcher whose `PATH` lacks `~/.local/bin`), pass the `PATH` explicitly:

```bash
claude mcp add zwilling -s user -e PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" -- node /absolute/path/to/zwilling/dist/index.js
```

## Tools

| Tool | Inputs | What it does |
|---|---|---|
| `ask_gemini` | `prompt`, `files?`, `model?`, `follow_up?` | Ask a question or hand Gemini a task, optionally with files inlined as context. `follow_up` takes a log entry id and sends that earlier question and answer along (see [Follow-ups](#follow-ups)). |
| `gemini_review` | `files`, `focus?`, `model?` | Code review: concrete issues with file:line, severity, and a suggested fix. `focus` is e.g. `security`, `performance`, `readability`. |
| `read_gemini_log` | `last_n?` (default 5), `id?`, `tool?`, `query?` | Returns the last N matching log entries, so Claude can recall earlier answers. `id` picks one entry, `tool` filters by tool name, `query` by a case-insensitive search text. |

`files` are paths relative to the project root. Their contents are added to the prompt as:

```
<prompt>

--- FILE: src/auth.ts ---
<contents>
```

A short fixed preamble goes before every prompt. It tells Gemini it has no tools and that everything it needs is inline; without it, Gemini wastes the timeout retrying blocked tools.

### Models and reasoning effort

`model` takes any ID from `agy models`. For Gemini, the reasoning effort is part of the ID:

```
gemini-3.8-flash-low
gemini-3.8-flash-medium
gemini-3.8-flash-high
```

If you leave `model` out, `agy` uses its default from `~/.gemini/antigravity-cli/settings.json` (`"model"`), which you can also change with `/model` inside `agy`. Higher effort is slower: with medium effort, a review of two files took 19–83 s.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ZWILLING_ROOT` | `$CLAUDE_PROJECT_DIR`, else the server's cwd | Project root. File paths are confined to it, `agy` runs in it, and the log lives in it. Claude Code sets `CLAUDE_PROJECT_DIR` for every MCP server it starts, so you normally don't need this. |
| `ZWILLING_TIMEOUT_MS` | `120000` | Kill `agy` after this many ms and return a timeout error. |
| `ZWILLING_LOG_PATH` | `docs/ai/GEMINI_LOG.md` | Log file, relative to the project root. Paths outside the root (also via symlink) or inside `.git/` are rejected. |
| `ZWILLING_LOG` | on | `off` (or `0`, `false`, `no`) disables the log: nothing is written, `read_gemini_log` and `follow_up` say the log is off. |

Example: `claude mcp add zwilling -s user -e ZWILLING_TIMEOUT_MS=180000 -- node …/dist/index.js`

## Shared log

Every call to `ask_gemini` or `gemini_review` that reaches `agy` (successful or not) is appended to `docs/ai/GEMINI_LOG.md` in the project root (see `ZWILLING_LOG_PATH`, `ZWILLING_LOG`). The file is created if it's missing.

```markdown
<!-- zwilling:entry id=g-20261113-a1b2c3 -->
## 2026-11-13 19:45 · ask_gemini · model: default · id: g-20261113-a1b2c3
**Prompt:** <prompt on one line, first 500 chars>
<details><summary>Full prompt</summary>   (only if the line above isn't the exact prompt)
…
</details>
**Files:** src/auth.ts, src/session.ts
**Follow-up of:** g-20261113-0f9e8d       (only for follow-ups)
**Answer:**
<full answer>
---
```

Every entry has an id. The tool result ends with a separate text block `[zwilling: log entry g-…]`, so Claude can refer to it later.

The HTML comment is invisible when the markdown is rendered. zwilling uses it to split entries, because answers often contain `---` or headings themselves; if logged text contains the marker itself, it's defused with a zero-width space. Failed calls show `**Error:**` instead of `**Answer:**`. Calls rejected before reaching `agy` (a blocked path, too many files) are not logged. Entries from older versions (marker without id) can still be read, but have no id and only a 500-character prompt preview.

Parallel calls are written one after another, so entries never interleave.

The log is also available as MCP resources: `zwilling://log` (the whole log) and `zwilling://log/{id}` (one entry; the last 50 are listed).

Decide per project whether to commit the log or add it to `.gitignore`.

### Follow-ups

`ask_gemini` with `follow_up: "<id>"` looks up that entry and puts its full question and answer in front of the new prompt:

```
[Earlier exchange, log entry g-20261113-a1b2c3]
Files attached then (not attached again unless listed below): src/auth.ts

Question:
<earlier prompt>

Your answer:
<earlier answer>

[Follow-up question]
<new prompt>
```

Only that one entry is included, not its own history: a follow-up of a follow-up sees the previous question and answer, but not the exchange before it. Files from the earlier call are named but not sent again; pass them in `files` if Gemini needs them. Unknown ids, entries without an answer (failed calls), and a disabled log return a tool error.

## Safety

- **Your data goes to Google.** The prompt and every file you attach with `files` are sent to Gemini through `agy`, under your Google account's terms. Don't attach anything you wouldn't share with Google.
- **No shell.** `agy` is started with an argument array. The prompt goes over stdin as one `stream-json` message, so it isn't limited by the 128 KB per-argument limit on Linux and is never parsed as flags.
- **Read-only Gemini.** zwilling never passes `--dangerously-skip-permissions`. Each run gets one-off `--settings` (never saved) that deny `read_file(*)`, `write_file(*)`, `command(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)` and `download_url(*)`, plus `--sandbox`. Deny rules apply in every `agy` mode. File reads are denied too because `agy`'s permission rules don't support globs, so `*.pem` couldn't be blocked selectively.
- **Path confinement.** Every path is resolved against the root and rejected unless it's still inside the root after `realpath`. That blocks `../` and symlink escapes. `.env`, `.env.*`, `*.pem`, `*.key` and anything in `.git/` are rejected, also when reached through a symlink.
- **Limits.** At most 20 files and 500 KB of file content per call. Answers over 100 KB are truncated, and the response says so.
- **Timeout.** After 120 s (`ZWILLING_TIMEOUT_MS`), `agy`'s whole process group gets SIGTERM, then SIGKILL 2 s later. The same happens when the client cancels the call or the server shuts down, so no `agy` process is left behind.
- **stdout is only for the protocol.** All diagnostics go to stderr.
- **Errors as tool results.** A missing `agy`, a non-zero exit, an `ERROR` status or a timeout come back as `isError: true` with `agy`'s error and stderr. The server doesn't crash.

### Known limitations

- **Web search.** `agy`'s `search_web` tool has no permission action, so zwilling can't block it. It can't touch local files, but parts of your prompt could end up in a Google search query. The preamble tells Gemini not to use any tools.
- **No exploring.** Gemini can't look around the repository by itself. Attach everything it should see with `files`.
- **Large results.** Claude Code warns above 10k tokens of tool output and saves results over 50,000 characters to a file. Long answers, or `read_gemini_log` with a large `last_n`, may arrive that way.
- **MCP Inspector.** The Inspector CLI gives up after 60 s and doesn't request progress updates, so slow reviews time out there. Claude Code has no such limit for stdio servers. If a client sends a `progressToken`, zwilling sends a progress update every 10 s.

## Suggested `CLAUDE.md` / `AGENTS.md` snippet

```markdown
## Working with Gemini
- You have a `zwilling` MCP server.
- Use `gemini_review` before finishing any non-trivial change.
- Use `ask_gemini` with `files` when a task needs reading many large files at once.
- Gemini has no tool access: attach every file it needs via `files` (max 20 files / 500 KB).
- Optional `model`: gemini-3.8-flash-low | -medium | -high (effort level). Omit for the default.
- Treat Gemini's answer as a second opinion: verify claims against the code before acting.
```

## Development

```
src/index.ts    server setup, tool registration, shutdown handling
src/gemini.ts   runs agy: arguments, read-only settings, timeout, output parsing
src/paths.ts    root, path validation, file limits, prompt building
src/log.ts      markdown log: entry ids, append (serialized), read/parse, path checks
test/           vitest; test/fixtures/bin/agy is a fake agy put first on PATH
```

To try the server by hand: `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`

## License

ISC, see [LICENSE](LICENSE).

zwilling is an independent project and is not affiliated with or endorsed by Google. Gemini and Antigravity are trademarks of Google LLC.

This project was coded with AI. It has been reviewed and tested to the best of my knowledge and belief.
