# pi-digivolve

`pi-digivolve` is a pi package that ports the Digivolution idea from the Copilot CLI plugin to pi.

It helps agents leave a repository easier for the next agent to work in. Once per user prompt, near the point where the agent would otherwise stop, it queues one reflection pass asking the agent to decide whether durable repo instructions or in-repo skills should be improved. The agent may decide no change is warranted.

## What it updates

The extension is advisory: it does **not** directly auto-edit files. It asks the active agent to review the completed session and, only when useful, edit the narrowest appropriate guidance surface:

- `AGENTS.md`
- `.pi/skills/**/SKILL.md`
- `.agents/skills/**/SKILL.md`
- existing cross-agent files such as `CLAUDE.md`, `.github/copilot-instructions.md`, or `.github/instructions/*.instructions.md` when the repo intentionally uses them

## How it works in pi

Pi does not currently expose a cancellable `quit`/`agentStop` hook equivalent. Instead, `pi-digivolve` uses the closest safe lifecycle points:

- `input`: each genuine user prompt (`source` `"interactive"` or `"rpc"`) arms one reflection pass. The injected reflection prompt arrives as `source: "extension"`, so it never re-arms reflection and cannot trigger a loop.
- `agent_end`: when the agent finishes a prompt with no pending messages, it queues the armed reflection pass.

Reflection runs at most once per user message; arming resets on each new prompt.

Automatic reflection is enabled by default. Use `/digivolve off` or `/digivolve on` to persist the setting in pi's user config directory (`pi-digivolve.json`).

## Commands

```text
/digivolve          Run reflection now and mark this message as handled.
/digivolve force    Run reflection now even if it already ran for this message.
/digivolve status   Show whether the current message is armed or done, plus the config path.
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
