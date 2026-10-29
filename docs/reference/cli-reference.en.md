---
title: Tianshu CLI, Slash Commands & Configuration Reference (English)
type: reference
status: active
date: 2026-10-20
tags: [cli, reference, configuration, keybindings, english]
---

# CLI, Slash Commands & Configuration Reference

> English reference for Tianshu's command-line interface, core mechanics, slash commands,
> keybindings, and configuration. Mirrors [`docs/user-guide.md`](../user-guide.md) and
> [`docs/desktop-guide.md`](../desktop-guide.md), which are currently Chinese-only.
>
> Back to README.en.md · [中文 README](../../README.md)

## Command-Line Flags & Subcommands

| Flag | Description |
|------|-------------|
| `-p <prompt>` `--print <prompt>` | One-shot prompt; exits after text output (exit code: 0 success / 1 failure) |
| `--json` | With `-p`, emits a single JSON result |
| `--stream-json` | NDJSON event stream (`text_delta` / `tool_use` / `tool_result` / `worker` / `turn_complete` / `result`); output is auto-redacted, ideal for CI |
| `--goal "<task>"` | Headless goal autonomy; runs until the goal is met or `--budget` is exhausted |
| `--budget <N>` | Turn budget for goal mode (default 100) |
| `--model <name>` | Override the model for this session |
| `--provider <name>` | Override the provider for this session |
| `--profile <name>` | Boot with a named config profile (`RIVET_HOME/profiles/<name>.json` or built-in `lean`) |
| `--continue` `-c` | Resume the most recent session for this `cwd` |
| `--resume <id\|prefix>` `-r <id\|prefix>` | Resume a specific session (short prefix OK) |
| `--resume` `-r` (bare) | Open the session picker after startup |
| `--new` | Force a brand-new session |
| `--list` · `tianshu sessions` | Print the session list and exit |
| `--trust` / `--untrust` | Mark the current project directory as trusted / untrusted before loading config |
| `--dangerously-skip-permissions` | One-session Unattended mode (skip approvals; write sandbox stays on) |
| `--terminal-mode <mode>` | Terminal UI mode: `auto` (default) / `captured-pty` (plain-text line UI for remote/SSH/mobile) / `native` |
| `--screen-reader` | Screen-reader mode (dynamic segments not rendered; periodic redraw halted) |
| `--skip-welcome` | Skip the welcome screen |
| `--stream-events <path>` | Mirror this run as NDJSON `SessionEvent`s to a file |

**Subcommands**:

- `tianshu config` — View/manage config (`set-key`, `set-model`, `set-url`, `set-default`, `set-approval`, `providers`, `show`, `mcp ...`; for interactive setup in TUI, run `/connect`)
- `tianshu provider` — Provider & model management (`add | list | models | probe | remove`)
- `tianshu skills` — Unified skills management (`list | inspect | add | mode | update | remove | doctor | drafts | approve | reject | generate`)
- `tianshu serve` — Start the sidecar HTTP/SSE server (`[--port N] [--host ADDR] [--attach]`)
- `tianshu sessions` — List saved sessions
- `tianshu logs` — Show session/cache/CVM/sidecar log locations (`[--session <id>] [--json] [open [desktop]]`)
- `tianshu browser` — Chromium health check and one-shot install for `browser_debug` (`status | install [--no-mirror]`)
- `tianshu web` — CLI search and fetch (`search <query> | fetch <url> | status`)

## Prefix Cache Engine

- **Frozen prefix** — System prompt + tool definitions + stable context are frozen at session start and never rewritten within a session.
- **Delta appendix** — Dynamic context (progress, advisories, signals) is injected as an append-only cross-turn diff block (~200 bytes delta vs. ~5KB full rewrite).
- **Read-ref dedup** — Repeated reads of unchanged files return a compact reference instead of re-emitting full content.
- **Cache-aware compaction** — Compaction preserves the first 2 messages as the cache anchor and only rewrites history at user boundaries (`turn===0`).
- **Resume cache inheritance** — The frozen prefix snapshot is persisted to disk at every user boundary and on shutdown; on resume it is fed into the new engine, avoiding a byte-0 full miss.
- **Diagnostics & pricing indicator** — `/debug cache` shows hit rate, miss reason analysis, and per-turn cache history; official DeepSeek sessions display a live peak/off-peak badge (`◷闲½` / `◷峰`).

## Zen Mode: Read-Focused Start, Unlock on First Write

Zen Mode is **explicit opt-in (`enabled: false` by default)** so new sessions start with the full tool surface and zero cache breakpoints. When enabled via `{ "tools": { "zen": { "enabled": true } } }`, new sessions start with a narrowed read-only tool face (`read_file` / `grep` / `glob` / `repo_map` + `zen_unlock`), and automatically promote to the full toolset on the first hands-on action (`triage` for short single-line prompts, `tool` call, 8-turn `timeout`, or manual `/fast`).

## Subagent Orchestration & Tool Presets

Presets separate registration from main-agent visibility. Resolution order: environment > project preset > project domain override > user preset > user domain override > built-in domain default > **minimal**. Baselines below exclude MCP/LSP, schedulers and forced extras.

| Preset | Registered / main-visible | Description |
|---|---|---|
| **minimal** (default) | 36 / 26 | Daily development, basic delegation, team, memory, capsules and image queries |
| **frontend** | 37 / 27 | minimal + `browser_debug` |
| **orchestration** | 36 / 30 | minimal + `galaxy`, `starflow`, `plan_task`, `council_convene`; full is not required |
| **full** | 56 / 43 | All assembly capabilities and advanced orchestration; cold tools retain explicit visibility controls |
| **taiyi** | 14 / 13 | Frozen evaluation baseline; `diff` stays cold |

A real scheduler registers three additional tools. They are visible by default only in full/taiyi. Use `/tools enable <name>` for explicit activation in other presets. Readonly workers retain `git_scout`; the default main agent uses `git`.

`/tools` reports actual registered and visible tools, cold tools, missing tools and explicit restrictions. `/galaxy`, `/starflow` and `/council` mount only the requested tool, respect restrictions, and disclose the one-time cache impact. They do not upgrade the preset. Settings apply to subsequent sessions.

Default `/team` directly accepts `planPath` or `planMarkdown` with `### Task N: title` headings, exact files, dependencies and acceptance criteria. It does not require `plan_task`. Explicit current plans take priority over stored plans; `/team max` retains its existing entitlement policy. Execution, commits, verification and review remain separate facts.

## Plan Mode

Design-first workflow (`/plan-mode` toggle, or automatic entry on complex tasks via `RIVET_PLAN_MODE_SUGGEST=auto`):

1. **Investigate** — Read code and optionally dispatch parallel `code_scout` workers.
2. **Produce a plan** — Write a structured plan to `.rivet/plans/<slug>.md`.
3. **Submit for approval** — `plan` tool (`action=submit`) presents key points and options.
4. **Approve or reject** — Inspect with `/plan-list` / `/plan-view`, launch wave execution with `/plan-approve <slug>`, or request revisions with `/plan-reject <slug> <feedback>`.
5. **Close** — `/plan-close <file> --tasks <range|all> [--preview]`.

> For read-only Q&A and requirement clarification without writing files, toggle **Ask Mode** with `/ask`.

## Session Handoff & Resume

- **Handoff (`/handoff [note]`)** — Writes a 5-section structured handoff document (**Objective**, **Done** with file/test evidence, **Blocker**, **Next steps**, **Pitfalls**) to `.rivet/HANDOFF.md` and archives it to `<id>.handoff.md` in the session directory. (Automatic `<prev-session-handoff>` injection into the next session is off by default for parallel-session safety; enable with `RIVET_PREV_HANDOFF=1`.)
- **Resume (`--continue` / `--resume` / `/resume`)** — Restores the session with frozen-prefix cache inheritance, preflight orphan write-evidence repair, model affinity, and UI state (todos, side panel, active plan).
- **Rewind (`Esc` `Esc` within 400ms)** — Rewind to any past user message with three restore granularities (**conversation only / code changes only / both**) and a file-impact preview.

## Skills System, Cross-Session Memory & MCP

- **Skills** — Reusable workflow playbooks (`visual-acceptance` bundled; project skills in `.rivet/skills/*.md`). Manage from CLI via `tianshu skills` or in-session via `/skill <name>`. Skills are snapshotted per session so mid-session edits do not fragment the prefix cache.
- **Cross-Session Memory** — Stored in `.rivet/knowledge/memory.jsonl` with `memory-index.sqlite` for hybrid search. Auto-injection only loads governance/constraint/preference memories; manage with `/memory`, `/remember <text>`, and `/forget <entryId> [resolved]`.
- **MCP (Model Context Protocol)** — Add external tool servers with `tianshu config mcp add-stdio|add-sse|add-preset` and inspect in-session with `/mcp` and `/debug mcp`.

## Terminal UI (TUI) & Keybindings

| Key | Action |
|-----|--------|
| `Enter` / `Shift+Enter` | Send message / insert newline |
| `Alt+Enter` or `/steer <text>` | Immediate mid-stream interrupt (`now` priority at next tool boundary) |
| `Ctrl+C` | Abort active run; clear non-empty input; double-press within 2s when idle to exit |
| `Esc` / `Esc Esc` (<400ms) | Close overlay or interrupt active run / double-tap to open **Rewind** |
| `Ctrl+P` | Command palette (fuzzy search all slash commands and surface actions) |
| `Ctrl+]` | Toggle right-side fleet/DAG/todo/token drawer (wide terminals ≥100 cols) |
| `Ctrl+R` | History search overlay (when idle) |
| `Ctrl+O` / `Ctrl+T` | Expand/collapse truncated tool output / thinking block |
| `Ctrl+V` | Paste clipboard image (auto-converted to inline base64) |
| `@` | Trigger `@file:` / `@folder:` / `@symbol:` completion |
| `F1`–`F8` | Direct bindings: `F1` `/help` · `F2` `/tasks` · `F3` `/cache` · `F4` `/cockpit` · `F5` `/theme` · `F6` `/model` · `F7` `/permission` · `F8` `/sessions` |

## Slash Commands Reference

<details>
<summary><b>Click to expand full Slash Commands tables (Session, Model, Planning, Subagents, Context, UI)</b></summary>

**Session & Project**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` · `/resume <n>` | List or restore saved sessions |
| `/fork` | Fork the current session |
| `/handoff [note]` | Write a 5-section structured handoff document to `.rivet/HANDOFF.md` and archive it |
| `/init` | Interactive project initialization (verify claims / skills / hooks scaffolding) |
| `/doctor` | Environment health check + active shell used by the `bash` tool |
| `/logs [open [desktop]]` | Show session, cache, CVM (`sensorium.jsonl`), and desktop sidecar log locations |
| `/connect` | Interactive provider connection wizard |
| `/config` · `/settings` · `/setup` | Interactive settings panel (routing, review models, vision, tool preset, mirrors, search) |
| `/cd <path>` | Switch working directory mid-session while preserving prefix cache |
| `/trust` | Manage project trust gate |
| `/usage` · `/token-ledger` | View local cumulative token ledger (`status \| sync \| auto on \| auto off \| connect \| disconnect`) |
| `/exit` · `/quit` | Save session and exit |

**Model & Permissions**

| Command | Description |
|---------|-------------|
| `/model [name\|list]` | Show or switch model/provider |
| `/effort [off\|low\|medium\|high\|max\|auto]` | Control reasoning depth (default `high`; routine turns auto-downgrade; explicit `max` is protected) |
| `/permission [supervise\|auto\|unattended\|...]` | Manage approval tier and tool/bash allow/deny rules |
| `/yes [off]` · `/yolo [off]` | One-key Unattended mode (`off` returns to Auto; persisted across restarts) |
| `/approve` · `/reject` | Approve or reject pending tool execution in plain-text (`captured-pty`) mode |
| `/domain [list\|<name>\|auto\|off]` | View or switch star-domain cognitive stance |

**Planning, Orchestration & Review**

| Command | Description |
|---------|-------------|
| `/goal <text>` · `/cancel-goal` | Start or stop autonomous goal execution |
| `/plan <feature>` · `/plan-mode` | Draft a plan or toggle Plan Mode |
| `/plan-list` · `/plan-view [ref]` | List or preview plans in-session |
| `/plan-approve <slug>` · `/plan-reject <slug> [feedback]` | Approve plan for wave execution or reject with feedback |
| `/plan-close <file> --tasks <range\|all> [--preview]` | Close a completed plan |
| `/ask` | Toggle read-only Ask Mode |
| `/council <text> [--rounds 2]` | Convene multi-seat expert review (Tianquan / Tianfu / Tianxuan) |
| `/team <plan.md>` | Execute a plan in parallel across multiple worker agents |
| `/scout <target> [--dims a,b,c]` | Parallel read-only reconnaissance swarm producing an evidence-backed checklist |
| `/review [max]` | Run manual adversarial code review (L2 or L3 5-seat review squad) |
| `/steer <text>` | Inject a mid-stream instruction at `now` priority at the next tool boundary |

**Subagents, Context, Debugging & UI**

| Command | Description |
|---------|-------------|
| `/tasks` · `/enter <orderId> [prompt]` | Open worker task panel or enter/resume a worker session |
| `/jobs` | Open background shell jobs panel |
| `/compact` · `/context` · `/evidence` | Compact context immediately, inspect context ledger, or view collected evidence |
| `/memory` · `/remember <text>` · `/forget <id> [resolved]` | Inspect, add, or invalidate project long-term memory entries |
| `/btw <question>` | Ask a side question in a floating overlay without polluting conversation history |
| `/cvm [off\|intercept\|warn\|all]` | Set live CVM interception notice verbosity on the main screen |
| `/debug [prompt\|cache\|mcp]` · `/mcp` · `/verbose` | Inspect prompt/cache/MCP diagnostics or toggle verbose tool output |
| `/rollback` · `/undo` | Restore a Git checkpoint or undo the last file modification |
| `/cockpit` · `/theme [name\|list]` · `/vim` · `/scroll` · `/update` | Toggle Cockpit, switch color theme, toggle vim mode, scroll history, or update via npm |

</details>

## Key Config Cheatsheet (`~/.rivet/config.json` & Env Vars)

<details>
<summary><b>Click to expand Environment Variables & Annotated <code>config.json</code></b></summary>

| Variable | Effect |
|----------|--------|
| `RIVET_HOME` | Override `~/.rivet` data root for CLI (Desktop uses Settings → Storage) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `RIVET_TOOL_PRESET` | Toolset preset: `minimal` (default) / `frontend` / `orchestration` / `full` / `taiyi` |
| `RIVET_LEAN=1` | Enable Lean resource tier for low-memory / low-disk machines |
| `RIVET_LANG=en` | Switch Cockpit panel labels to English (default `zh`) |
| `RIVET_TERMINAL_MODE` | Terminal UI mode: `auto` / `captured-pty` / `native` |
| `RIVET_SERVE_LAN_DIRECT=1` | Enable LAN Direct self-signed TLS mode for mobile remote access |
| `RIVET_DEBUG=1` / `RIVET_DEBUG_TELEMETRY=1` | Enable debug logging / full `sensorium.jsonl` CVM telemetry |
| `RIVET_NO_UPDATE_CHECK=1` | Disable startup auto-update check |

Example `~/.rivet/config.json` (only write overrides; defaults are deep-merged — validated against `src/config/schema.ts`):

```jsonc
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKey": "sk-xxx",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 384000 }
        ]
      }
    }
  },
  "agent": {
    "maxTurns": 200,              // max turns per session (default 200)
    "approval": "auto-safe",      // manual | auto-safe | dangerously-skip-permissions
    "crossSessionEnabled": true,  // cross-session knowledge sharing
    "checkpointEveryTurns": 0,    // Auto-mode checkpoint interval (0 = off)
    "defaultDomain": "qiming",    // default star domain (qiming | auto | explicit domain id)
    "visionModel": {              // vision bridge when primary model is text-only
      "provider": "minimax",
      "model": "MiniMax-M3"
    },
    "visionAutoBridge": false,
    "imageGenModel": {            // dedicated text-to-image slot
      "provider": "siliconflow-image",
      "model": "black-forest-labs/FLUX.2-pro",
      "size": "1024x1024",
      "sizeField": "image_size"
    },
    "permissions": {
      "allow": [{ "tool": "read" }],
      "deny":  [{ "tool": "bash", "params": { "command": "rm -rf" } }],
      "bash": { "allowlist": ["git status"], "denylist": ["git push"] }
    }
  },
  "compact": {
    "enabled": true,
    "autoThreshold": 800000
  },
  "tools": {
    "preset": "minimal"           // minimal (default) | frontend | orchestration | full | taiyi
  },
  "workers": {
    "profiles": {
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" },
      "cheap":   { "provider": "minimax",  "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" },
    "patcherTier": "cheap"
  },
  "search": {
    "backends": ["bing", "duckduckgo"],
    "braveApiKeyEnv": "BRAVE_API_KEY",
    "tavilyApiKeyEnv": "TAVILY_API_KEY",
    "bochaApiKeyEnv": "BOCHA_API_KEY",
    "serplyApiKeyEnv": "SERPLY_API_KEY"
  },
  "ui": {
    "theme": "auto",
    "reducedMotion": true,
    "screenReader": true,
    "glanceDensity": "compact",
    "cvmNotices": "intercept",
    "cvmNoticeWindowMs": 8000
  },
  "mirrors": { "enabled": true, "preset": "china" },
  "env": { "extraPath": ["/usr/local/bin"] }
}
```

</details>
