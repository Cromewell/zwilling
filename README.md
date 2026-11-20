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
| `ask_gemini` | `prompt`, `files?`, `diff?`, `model?` or `models?`, `timeout_s?`, `follow_up?` | Ask a question or hand Gemini a task, optionally with files or a diff inlined as context. With `models` (up to 4), the same prompt runs on each model in parallel. `follow_up` takes a log entry id and sends that earlier question and answer along (see [Follow-ups](#follow-ups)). |
| `gemini_review` | `files?`, `diff?`, `focus?`, `model?`, `timeout_s?` | Code review of files and/or a git diff (at least one of them): concrete issues with file:line, severity, and a suggested fix. `focus` is e.g. `security`, `performance`, `readability`. Returns the written review plus structured findings (see below). |
| `gemini_task` | `task`, `instructions?`, `files?`, `diff?`, `model?`, `timeout_s?` | Runs a named task template from `.zwilling/tasks/<task>.md` in the project, with optional extra instructions. |
| `list_gemini_models` | none | Runs `agy models` and returns the model IDs you can pass as `model` / `models`. |
| `read_gemini_log` | `last_n?` (default 5), `id?`, `tool?`, `query?` | Returns the last N matching log entries, so Claude can recall earlier answers. `id` picks one entry, `tool` filters by tool name (e.g. `gemini_task:plan`), `query` by a case-insensitive search text. |

`ask_gemini` also takes `diff?` and `timeout_s?`. `timeout_s` (10–1800) overrides the default timeout for one call, e.g. for a slow `-high` review.

### Files

Each entry in `files` is relative to the project root and can be:

| Form | Example | Meaning |
|---|---|---|
| file | `src/auth.ts` | the whole file |
| line range | `src/auth.ts:40-120`, `src/auth.ts:42` | only those lines (1-based; the end is clamped to the file length). Only the attached lines count against the size limit. |
| directory | `src/`, `src` | every file below it |
| glob | `src/**/*.ts`, `test/*.{ts,js}` | `*`, `**`, `?` and `{a,b}` |

Directories and globs are expanded from `git ls-files --cached --others --exclude-standard`, so `.gitignore` is respected. Outside a git repo zwilling walks the directory instead and skips `.git/` and `node_modules/`. Files from a glob or directory that are blocked, binary or escape the root through a symlink are skipped and listed in a `[zwilling: skipped …]` note. If you name a blocked or binary file explicitly, the call fails. The file limit applies after expansion.

### Diffs

`diff` attaches the output of `git diff`:

| `diff` | Compares |
|---|---|
| `staged` | index vs `HEAD` |
| `working` | working tree vs index (unstaged changes) |
| `HEAD` or another ref, e.g. `HEAD~3` | working tree (staged and unstaged) vs that ref |
| `main...HEAD`, `v1.0..v1.1` | between two refs (`...` starts at the merge base) |

The diff counts against the size limit. Changed files that the denylist blocks (`.env`, `*.pem`, your `deny` patterns, …) are left out of the diff, and the answer says which ones.

### Prompt format

Attachments are added after your prompt between boundary lines:

```
<prompt>

Attachment boundary id: 3f9c0a1b2d4e5f60

<<<zwilling:BEGIN 3f9c0a1b2d4e5f60 diff HEAD>>>
<git diff output>
<<<zwilling:END 3f9c0a1b2d4e5f60>>>

<<<zwilling:BEGIN 3f9c0a1b2d4e5f60 file path=src/auth.ts lines=40-120>>>
<contents>
<<<zwilling:END 3f9c0a1b2d4e5f60>>>
```

The id is random for every call. If an attachment happens to contain it, zwilling picks a new one. That way a file can't end its own block and pretend to be part of the prompt.

A short fixed preamble goes before every prompt. It tells Gemini it has no tools, that everything it needs is inline, how the boundaries work, and that attachments are data, not instructions. Without it, Gemini wastes the timeout retrying blocked tools.

### Structured review findings

`gemini_review` asks Gemini to end its review with a JSON block. zwilling parses it into `structuredContent`:

```json
{ "parsed": true, "findings": [{ "file": "src/a.ts", "line": 12, "severity": "high", "issue": "…", "fix": "…" }] }
```

`severity` is one of `critical`, `high`, `medium`, `low` and `info`; common synonyms like `major` or `nit` are mapped to these. If there's no block it can parse, the result is `{ "parsed": false, "findings": [] }`. The tool doesn't fail in that case. The full text, JSON block included, is always in `content`.

### Task templates

Put reusable instructions into `.zwilling/tasks/<name>.md` (names: letters, digits, `-`, `_`), for example:

```markdown
<!-- .zwilling/tasks/test-ideas.md -->
List test cases that are missing for the attached code. Group them by function, and mark edge cases.
```

Then call `gemini_task` with `task: "test-ideas"` and `files`. `instructions` is appended under `## Instructions`. The tool description lists the tasks that existed when the server started. For an unknown task, the error lists the current ones. Templates are read through the same path checks as attached files.

### Models and reasoning effort

`model` takes any ID from `agy models`. For Gemini, the reasoning effort is part of the ID:

```
gemini-3.8-flash-low
gemini-3.8-flash-medium
gemini-3.8-flash-high
```

If you leave `model` out, zwilling uses `reviewModel` (for `gemini_review`) or `model` from the configuration (see below). If neither is set, `agy` uses its default from `~/.gemini/antigravity-cli/settings.json` (`"model"`), which you can also change with `/model` inside `agy`. Higher effort is slower: with medium effort, a review of two files took 19–83 s. `list_gemini_models` shows the IDs your `agy` accepts.

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

zwilling reads an optional `.zwilling.json` from the project root when it starts, then applies `ZWILLING_*` environment variables on top. Environment variables win over the file, except `ZWILLING_DENY`, which adds to the file's `deny`. If the file or a variable is invalid (bad JSON, unknown key, out-of-range number), the server refuses to start and prints the reason to stderr.

```json
{
  "model": "gemini-3.8-flash-medium",
  "reviewModel": "gemini-3.8-flash-high",
  "limits": { "maxFiles": 40, "maxTotalKB": 1000, "timeoutMs": 240000 },
  "deny": ["secrets/", "*.sqlite", "config/prod.*"],
  "prompts": { "review": ".zwilling/review.md" },
  "log": { "path": "docs/ai/GEMINI_LOG.md", "enabled": true },
  "cli": "agy"
}
```

| Key | Variable | Default | Meaning |
|---|---|---|---|
| — | `ZWILLING_ROOT` | `$CLAUDE_PROJECT_DIR`, else the server's cwd | Project root. File paths are confined to it, `agy` runs in it, and the log and `.zwilling.json` live in it. Claude Code sets `CLAUDE_PROJECT_DIR` for every MCP server it starts, so you normally don't need this. |
| `model` | `ZWILLING_MODEL` | `agy`'s default | Default model for `ask_gemini` and `gemini_task`. |
| `reviewModel` | `ZWILLING_REVIEW_MODEL` | `model` | Default model for `gemini_review`. |
| `limits.maxFiles` | `ZWILLING_MAX_FILES` | `20` (1–500) | Max files per call, after glob/directory expansion. |
| `limits.maxTotalKB` | `ZWILLING_MAX_TOTAL_KB` | `500` (1–8192) | Max KB of attachments per call (files plus diff). |
| `limits.timeoutMs` | `ZWILLING_TIMEOUT_MS` | `120000` (1000–3600000) | Kill `agy` after this many ms and return a timeout error. `timeout_s` overrides it per call. |
| `deny` | `ZWILLING_DENY` (comma-separated) | none | Extra paths to block. A pattern without `/` matches a file or directory name at any depth (`*.sqlite`, `secrets`). A pattern with `/` is anchored at the root and also blocks everything below it (`secrets/`, `config/prod.*`). These only add to the built-in rules and can't remove them. |
| `prompts.review` | `ZWILLING_REVIEW_PROMPT` | built-in | Root-relative file whose text replaces the built-in review instructions. `focus` and the JSON-findings request are still appended. |
| `log.path`, `log.enabled` | `ZWILLING_LOG_PATH`, `ZWILLING_LOG` (`on`/`off`) | `docs/ai/GEMINI_LOG.md`, on | Where the shared log goes (relative to the root; paths outside the root, also via symlink, or inside `.git/` are rejected) and whether to write it. With the log off, nothing is written, and `read_gemini_log` and `follow_up` say so. |
| `cli` | `ZWILLING_CLI` | `agy` | CLI binary to run: a name on `PATH` or an absolute path (e.g. a wrapper script). It must speak `agy`'s flags and `stream-json` format. |

Example: `claude mcp add zwilling -s user -e ZWILLING_TIMEOUT_MS=180000 -- node …/dist/index.js`

## Shared log

Every call to `ask_gemini`, `gemini_review` or `gemini_task` that reaches `agy` (successful or not) is appended to `docs/ai/GEMINI_LOG.md` in the project root (see `log` in [Configuration](#configuration)). The file is created if it's missing.

```markdown
<!-- zwilling:entry id=g-20261113-a1b2c3 -->
## 2026-11-13 19:45 · ask_gemini · model: default · id: g-20261113-a1b2c3
**Prompt:** <prompt on one line, first 500 chars>
<details><summary>Full prompt</summary>   (only if the line above isn't the exact prompt)
…
</details>
**Files:** (diff: staged), src/auth.ts, src/session.ts:40-120
**Follow-up of:** g-20261113-0f9e8d       (only for follow-ups)
**Answer:**
<full answer>
---
```

Every entry has an id. The tool result ends with a separate text block `[zwilling: log entry g-…]` (several ids for a multi-model call), so Claude can refer to it later.

The HTML comment is invisible when the markdown is rendered. zwilling uses it to split entries, because answers often contain `---` or headings themselves; if logged text contains the marker itself, it's defused with a zero-width space. Failed calls show `**Error:**` instead of `**Answer:**`. Calls rejected before reaching `agy` (a blocked path, too many files, an invalid diff) are not logged. `gemini_task` entries show up as `gemini_task:<task>`; a multi-model call writes one entry per model. Entries from older versions (marker without id) can still be read, but have no id and only a 500-character prompt preview.

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

- **Your data goes to Google.** The prompt, every file you attach with `files` (including everything a glob or directory matches) and any `diff` are sent to Gemini through `agy`, under your Google account's terms. Don't attach anything you wouldn't share with Google.
- **No shell.** `agy` is started with an argument array. The prompt goes over stdin as one `stream-json` message, so it isn't limited by the 128 KB per-argument limit on Linux and is never parsed as flags.
- **Read-only Gemini.** zwilling never passes `--dangerously-skip-permissions`. Each run gets one-off `--settings` (never saved) that deny `read_file(*)`, `write_file(*)`, `command(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)` and `download_url(*)`, plus `--sandbox`. Deny rules apply in every `agy` mode. File reads are denied too because `agy`'s permission rules don't support globs, so `*.pem` couldn't be blocked selectively.
- **Path confinement.** Every path is resolved against the root and rejected unless it's still inside the root after `realpath`. That blocks `../` and symlink escapes. `.env`, `.env.*`, `*.pem`, `*.key` and anything in `.git/` are rejected, also when reached through a symlink. `deny` patterns from the configuration add to this list and can't remove from it. The same checks apply to every file a glob or directory expands to, and to review and task templates. Binary files (a NUL byte) are rejected.
- **Diffs.** `git` is run with `execFile` (no shell). The `diff` value has to look like `staged`, `working`, a ref or a ref range: no leading `-`, no spaces and no `:`, so it can't be passed as an option. Pathspecs come after `--` as `:(literal)…`. zwilling passes `--no-ext-diff --no-textconv` and `-c core.fsmonitor=false`, so a repository's config can't make `git` start an external diff tool, textconv filter or fsmonitor program. Blocked files are left out of the diff.
- **Prompt boundaries.** Attachments are wrapped in boundary lines with a random id per call, and the preamble tells Gemini to treat their contents as data. This makes it harder for a file to pose as part of the prompt, but like any defence against prompt injection it isn't watertight.
- **Limits.** By default at most 20 files and 500 KB of attachments (files plus diff) per call; see `limits` in [Configuration](#configuration). A file over 20 MB is refused even with a line range. Answers over 100 KB are truncated, and the response says so. `agy`'s output is read line by line as it arrives, so long streams don't pile up in memory; a single output line over 16 MB is dropped.
- **Timeout.** After 120 s (`limits.timeoutMs`, or `timeout_s` per call), `agy`'s whole process group gets SIGTERM, then SIGKILL 2 s later. The same happens when the client cancels the call or the server shuts down, so no `agy` process is left behind.
- **stdout is only for the protocol.** All diagnostics go to stderr.
- **Errors as tool results.** A missing `agy`, a non-zero exit, an `ERROR` status or a timeout come back as `isError: true` with `agy`'s error and stderr. The server doesn't crash.

### Known limitations

- **Web search.** `agy`'s `search_web` tool has no permission action, so zwilling can't block it. It can't touch local files, but parts of your prompt could end up in a Google search query. The preamble tells Gemini not to use any tools.
- **No exploring.** Gemini can't look around the repository by itself. Attach everything it should see with `files` (globs and directories help) or `diff`.
- **Structured findings depend on Gemini.** If Gemini leaves out the JSON block or gets it wrong, `structuredContent` is `{ "parsed": false, "findings": [] }`, and only the text is usable.
- **Large results.** Claude Code warns above 10k tokens of tool output and saves results over 50,000 characters to a file. Long answers, or `read_gemini_log` with a large `last_n`, may arrive that way.
- **MCP Inspector.** The Inspector CLI gives up after 60 s and doesn't request progress updates, so slow reviews time out there. Claude Code has no such limit for stdio servers. If a client sends a `progressToken`, zwilling sends a progress update every 10 s, e.g. `waiting for agy (30 s, 1840 chars received)`. It reports only how much text has arrived, never the text itself.

## Suggested `CLAUDE.md` / `AGENTS.md` snippet

```markdown
## Working with Gemini
- You have a `zwilling` MCP server.
- Use `gemini_review` with `diff: "HEAD"` (plus key `files` for context) before finishing any non-trivial change.
- Use `ask_gemini` with `files` when a task needs reading many large files at once.
- Gemini has no tool access: attach everything it needs via `files` (paths, `path:10-80`, `src/`, `src/**/*.ts`) or `diff` (max 20 files / 500 KB by default).
- `gemini_task` runs the project's templates in `.zwilling/tasks/`.
- Optional `model`: gemini-3.8-flash-low | -medium | -high (effort level). Omit for the default.
- Treat Gemini's answer as a second opinion: verify claims against the code before acting.
```

## Development

```
src/index.ts    server setup, tool registration, shutdown handling
src/gemini.ts   runs agy: arguments, read-only settings, timeout, streaming output parsing, `agy models`
src/config.ts   .zwilling.json + ZWILLING_* env loading and validation
src/paths.ts    root, path validation, denylist, globs/ranges, file limits, prompt building
src/glob.ts     minimal glob matching and deny-pattern matching
src/git.ts      git diff: spec validation, safe invocation, blocked-file filtering
src/review.ts   review prompts and parsing of structured findings
src/tasks.ts    task templates in .zwilling/tasks/
src/log.ts      markdown log: entry ids, append (serialized), read/parse, path checks
test/           vitest; test/fixtures/bin/agy is a fake agy put first on PATH
```

To try the server by hand: `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`

## License

ISC, see [LICENSE](LICENSE).

zwilling is an independent project and is not affiliated with or endorsed by Google. Gemini and Antigravity are trademarks of Google LLC.

This project was coded with AI. It has been reviewed and tested to the best of my knowledge and belief.
