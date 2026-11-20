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
| `ask_gemini` | `prompt`, `files?`, `model?` or `models?` | Ask a question or hand Gemini a task, optionally with files inlined as context. With `models` (up to 4), the same prompt runs on each model in parallel. |
| `gemini_review` | `files`, `focus?`, `model?` | Code review: concrete issues with file:line, severity, and a suggested fix. `focus` is e.g. `security`, `performance`, `readability`. |
| `list_gemini_models` | none | Runs `agy models` and returns the model IDs you can pass as `model` / `models`. |
| `read_gemini_log` | `last_n?` (default 5) | Returns the last N log entries, so Claude can recall earlier answers. |

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

If you leave `model` out, `agy` uses its default from `~/.gemini/antigravity-cli/settings.json` (`"model"`), which you can also change with `/model` inside `agy`. Higher effort is slower: with medium effort, a review of two files took 19–83 s. `list_gemini_models` shows the IDs your `agy` accepts.

### Comparing models

`ask_gemini` with `models: ["gemini-3.8-flash-low", "gemini-3.8-flash-high"]` runs one `agy` per model in parallel, with the same prompt and files. The answers come back one after the other, each under a heading:

```
## [zwilling] model: gemini-3.8-flash-low

<answer>

## [zwilling] model: gemini-3.8-flash-high (failed)

<error>
```

Each run gets its own log entry. If only some models fail, their errors are shown inline and the call succeeds; it's an error only if every model failed. `model` and `models` can't be combined.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ZWILLING_ROOT` | `$CLAUDE_PROJECT_DIR`, else the server's cwd | Project root. File paths are confined to it, `agy` runs in it, and the log lives in it. Claude Code sets `CLAUDE_PROJECT_DIR` for every MCP server it starts, so you normally don't need this. |
| `ZWILLING_TIMEOUT_MS` | `120000` | Kill `agy` after this many ms and return a timeout error. |
| `ZWILLING_CLI` | `agy` | CLI binary to run: a name on `PATH` or an absolute path (e.g. a wrapper script). It must speak `agy`'s flags and `stream-json` format. |

Example: `claude mcp add zwilling -s user -e ZWILLING_TIMEOUT_MS=180000 -- node …/dist/index.js`

## Shared log

Every call to `ask_gemini` or `gemini_review` that reaches `agy` (successful or not) is appended to `docs/ai/GEMINI_LOG.md` in the project root. The file is created if it's missing.

```markdown
<!-- zwilling:entry -->
## 2026-11-13 19:45 · ask_gemini · model: default
**Prompt:** <first 500 chars of prompt>
**Files:** src/auth.ts, src/session.ts
**Answer:**
<full answer>
---
```

The HTML comment is invisible when the markdown is rendered. `read_gemini_log` uses it to split entries, because answers often contain `---` or headings themselves. Failed calls show `**Error:**` instead of `**Answer:**`. Calls rejected before reaching `agy` (a blocked path, too many files) are not logged.

Decide per project whether to commit the log or add it to `.gitignore`.

## Safety

- **Your data goes to Google.** The prompt and every file you attach with `files` are sent to Gemini through `agy`, under your Google account's terms. Don't attach anything you wouldn't share with Google.
- **No shell.** `agy` is started with an argument array. The prompt goes over stdin as one `stream-json` message, so it isn't limited by the 128 KB per-argument limit on Linux and is never parsed as flags.
- **Read-only Gemini.** zwilling never passes `--dangerously-skip-permissions`. Each run gets one-off `--settings` (never saved) that deny `read_file(*)`, `write_file(*)`, `command(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)` and `download_url(*)`, plus `--sandbox`. Deny rules apply in every `agy` mode. File reads are denied too because `agy`'s permission rules don't support globs, so `*.pem` couldn't be blocked selectively.
- **Path confinement.** Every path is resolved against the root and rejected unless it's still inside the root after `realpath`. That blocks `../` and symlink escapes. `.env`, `.env.*`, `*.pem`, `*.key` and anything in `.git/` are rejected, also when reached through a symlink.
- **Limits.** At most 20 files and 500 KB of file content per call. Answers over 100 KB are truncated, and the response says so. `agy`'s output is read line by line as it arrives, so long streams don't pile up in memory; a single output line over 16 MB is dropped.
- **Timeout.** After 120 s (`ZWILLING_TIMEOUT_MS`), `agy`'s whole process group gets SIGTERM, then SIGKILL 2 s later. The same happens when the client cancels the call or the server shuts down, so no `agy` process is left behind.
- **stdout is only for the protocol.** All diagnostics go to stderr.
- **Errors as tool results.** A missing `agy`, a non-zero exit, an `ERROR` status or a timeout come back as `isError: true` with `agy`'s error and stderr. The server doesn't crash.

### Known limitations

- **Web search.** `agy`'s `search_web` tool has no permission action, so zwilling can't block it. It can't touch local files, but parts of your prompt could end up in a Google search query. The preamble tells Gemini not to use any tools.
- **No exploring.** Gemini can't look around the repository by itself. Attach everything it should see with `files`.
- **Large results.** Claude Code warns above 10k tokens of tool output and saves results over 50,000 characters to a file. Long answers, or `read_gemini_log` with a large `last_n`, may arrive that way.
- **MCP Inspector.** The Inspector CLI gives up after 60 s and doesn't request progress updates, so slow reviews time out there. Claude Code has no such limit for stdio servers. If a client sends a `progressToken`, zwilling sends a progress update every 10 s, e.g. `waiting for agy (30 s, 1840 chars received)`. It reports only how much text has arrived, never the text itself.

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
src/gemini.ts   runs agy: arguments, read-only settings, timeout, streaming output parsing, `agy models`
src/paths.ts    root, path validation, file limits, prompt building
src/log.ts      markdown log append/read
test/           vitest; test/fixtures/bin/agy is a fake agy put first on PATH
```

To try the server by hand: `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`

## License

ISC, see [LICENSE](LICENSE).

zwilling is an independent project and is not affiliated with or endorsed by Google. Gemini and Antigravity are trademarks of Google LLC.

This project was coded with AI. It has been reviewed and tested to the best of my knowledge and belief.
