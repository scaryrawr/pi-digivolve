# pi-digivolve

`pi-digivolve` is a pi package that ports the Digivolution idea from the Copilot CLI plugin to pi.

It helps agents leave a repository easier for the next agent to work in. Near the point where the agent would otherwise stop, it queues one final reflection pass asking the agent to decide whether durable repo instructions or in-repo skills should be improved. The agent may decide no change is warranted.

## What it updates

The extension is advisory: it does **not** directly auto-edit files. It asks the active agent to review the completed session and, only when useful, edit the narrowest appropriate guidance surface:

- `AGENTS.md`
- `.pi/skills/**/SKILL.md`
- `.agents/skills/**/SKILL.md`
- existing cross-agent files such as `CLAUDE.md`, `.github/copilot-instructions.md`, or `.github/instructions/*.instructions.md` when the repo intentionally uses them

## How it works in pi

Pi does not currently expose a cancellable `quit`/`agentStop` hook equivalent. Instead, `pi-digivolve` uses the closest safe lifecycle points:

- `turn_end`: when a turn ends with no tool results and no pending messages, it queues one follow-up reflection pass.
- `session_before_switch` and `session_before_fork`: if a session replacement is requested before reflection has run, it cancels once and queues reflection first.
- A session/repository guard is stored with `pi.appendEntry()` so the reflection pass runs at most once per session/repo.

Automatic reflection is enabled by default. Use `/digivolve off` or `/digivolve on` to persist the setting in pi's user config directory (`pi-digivolve.json`).

## Commands

```text
/digivolve          Run reflection now and mark this session/repo as handled.
/digivolve force    Run reflection now even if it already ran.
/digivolve status   Show whether the current session/repo is armed or done, plus the config path.
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
