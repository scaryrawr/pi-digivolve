# Repository Guidelines

## Project Structure & Module Organization

This is a pi package loaded directly by pi; do not add or commit generated build output. `package.json` declares the package entry in `main`, the pi extension in `pi.extensions`, and bundled skills in `pi.skills`. `extensions/digivolve.ts` registers lifecycle hooks and the `/digivolve` command. `extensions/digivolve/config.ts` owns user-level enabled-state persistence. Reflection always uses the active coding session's model. `skills/digivolution/SKILL.md` is the packaged reflection skill and should stay aligned with extension behavior.

## Reflection Loop Invariant

The ephemeral reflection session may load other extensions, including model-provider extensions, but must filter out `pi-digivolve` itself; this is the hard boundary preventing recursive side sessions. Its result may be returned only as a transient UI notification and must never be injected into conversation history with `pi.sendMessage()` or `pi.sendUserMessage()`. Keep the `input` event source check (`"interactive"`/`"rpc"` arm; `"extension"` does not), the `<!-- pi-digivolve -->` sentinel, and the single-flight guard as defense in depth. Never arm from `message_start` or message role. Reflection is armed once per genuine user message and consumed at most once per message. Automatic reflection must additionally require strong in-memory evidence: an explicit repository-specific user correction, a recovered command usage mistake, or repeated failed repo-local validation followed by a materially changed successful command against the same target. Do not trigger for an ordinary failure or successful validation alone. Automatic reflection starts only from `agent_settled`, after retries, compaction, and queued continuations are exhausted; tool events may collect evidence but must not start reflection, and `agent_end` must not trigger it.

Cancellation must cover the entire reflection task, including asynchronous resource and session creation before an `AgentSession` exists. Mark the owning task cancelled, await its cleanup, and let only that task release the single-flight guard; otherwise stale setup can later create a side session, overlap a newer reflection, or clear the newer task's guard.

## Build, Test, and Development Commands

- `npm run format` — format package files with oxfmt and sort imports.
- `npm run typecheck` — run `tsgo --noEmit` with strict TypeScript settings.
- `npm run lint` — run type-aware oxlint on extension sources.
- `npm run check` — run typecheck, then lint.
- `npm pack --dry-run` — verify the npm package ships only intended files.

Before committing, run `npm run format`, `npm run check`, then `npm pack --dry-run` in that order. `npm pack --dry-run` currently warns that no `.npmignore` exists and falls back to `.gitignore`; treat the tarball contents as the package check. For manual extension testing, use `pi -e ./extensions/digivolve.ts`; use `pi -e .` when the bundled skill should also be loaded.

## Coding Style & Naming Conventions

Use ESM TypeScript with NodeNext-style imports, including explicit `.ts` extensions for local imports. The project uses strict TypeScript options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitAny`) and oxlint forbids explicit `any`. Document exported/public APIs with concise comments. Keep pi core packages such as `@earendil-works/pi-coding-agent` as peer dependencies; put third-party runtime imports in `dependencies` because installed pi packages cannot rely on dev dependencies.

## Testing Guidelines

There is no committed test script yet. Treat `npm run check` plus `npm pack --dry-run` as the minimum validation path, and manually test lifecycle or command changes with pi when practical. When changing digivolution behavior or prompts, update all matching surfaces together: extension prompt text, `skills/digivolution/SKILL.md`, and README command/behavior docs.

## Commit & Pull Request Guidelines

Existing history uses short Conventional Commit-style subjects such as `feat:` and `docs:`. In PRs or handoffs, include the validation commands run and note any manual pi testing performed.
