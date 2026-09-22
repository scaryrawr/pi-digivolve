# pi-digivolve

`pi-digivolve` is a pi package that ports the Digivolution idea from the Copilot CLI plugin to pi.

It helps agents leave a repository easier for the next agent to work in. Near the point where the agent would otherwise stop, it may kick off an ephemeral side session (in-memory, not persisted) seeded with the main conversation history. Automatic reflection runs only when the current user turn contains strong evidence of a durable repository learning opportunity. The side session runs independently in the background without interrupting the current session's work and may decide no change is warranted.

## What it updates

The extension is advisory: it does **not** directly auto-edit files. The ephemeral side session reviews the completed session and, only when useful, edits the narrowest appropriate guidance surface:

- `AGENTS.md`
- `.pi/skills/**/SKILL.md`
- `.agents/skills/**/SKILL.md`
- existing cross-agent files such as `CLAUDE.md`, `.github/copilot-instructions.md`, or `.github/instructions/*.instructions.md` when the repo intentionally uses them

## How it works in pi

Pi does not currently expose a cancellable `quit`/`agentStop` hook equivalent. Instead, `pi-digivolve` uses the closest safe lifecycle points:

- `input`: each genuine user prompt (`source` `"interactive"` or `"rpc"`) starts a fresh in-memory turn monitor. The injected reflection prompt arrives as `source: "extension"`, so it never re-arms reflection and cannot trigger a loop.
- `tool_result`: failed and successful local `bash` validation operations are correlated using minimized command fingerprints and repo-local targets.
- `agent_settled`: once the agent has no automatic retry, compaction retry, or queued continuation left, it starts the ephemeral side session only if the turn has qualifying evidence.

Automatic reflection may run when:

- The user directly corrects a repository-specific command, instruction, setup step, convention, or workflow.
- A repo-local validation operation fails repeatedly and a materially changed operation against the same target succeeds.
- A command usage error is recovered by a materially changed validation command against the same repo-local target.

It does not trigger for ordinary test failures, long turns, repeated edits, generic frustration, network failures, or successful validation alone. Prompts, commands, tool output, and errors are inspected only in memory; failed commands are retained only as hashes plus minimized categories and targets.

Reflection runs at most once per user message; monitoring resets on each new prompt. If a reflection pass is already in flight when the user submits a new message, it is cancelled so the agent can settle cleanly and the new turn can be monitored.

The ephemeral side session follows the same pattern as `/btw` side chats: it is created with `SessionManager.inMemory(cwd)`, seeded with the main conversation history via `buildSessionContext`, given access to project skills and prompts through an explicitly initialized `DefaultResourceLoader`, and runs the reflection prompt independently. The loader preserves other extensions—including local-model provider extensions—but filters out `pi-digivolve` itself, which is the hard recursion boundary. When reflection produces a summary, it is delivered to the user as a transient toast notification (`ctx.ui.notify`) rather than injected into the conversation context. Because it never enters the message history, the main agent cannot see or be influenced by its own prior reflection output in subsequent turns.

Adaptive automatic reflection is enabled by default. Use `/digivolve off` or `/digivolve on` to persist the setting in pi's user config directory (`pi-digivolve.json`). Manual `/digivolve` remains available even when a turn has no automatic evidence. The reflection session always uses the active coding session's model.

## Commands

```text
/digivolve          Run reflection now and mark this message as handled.
/digivolve force    Run reflection now even if it already ran for this message.
/digivolve status   Show whether the current message is armed, its adaptive evidence state, and the config path.
/digivolve on       Enable automatic reflection and persist the setting.
/digivolve off      Disable automatic reflection and persist the setting.
```

## Installation

From this checkout:

```bash
pi install /path/to/pi-digivolve
```

For quick testing the extension alone:

```bash
pi -e ./extensions/digivolve.ts
```

For quick testing the extension plus bundled skill, load the package directory:

```bash
pi -e .
```

The package also provides a `digivolution` skill under `skills/digivolution/SKILL.md`.

## Development

```bash
npm run format
npm run check
```
