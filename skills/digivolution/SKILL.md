---
name: digivolution
description: Use this skill for end-of-task pi-digivolve reflection when deciding whether durable repo-specific guidance, AGENTS.md, pi skills, or in-repo SKILL.md files are stale, missing, or should be updated.
---

# Digivolution Skill

Use this skill for post-task reflection. If the work revealed durable knowledge that would help the next agent, improve the repository's guidance. Keep changes concise, local to the right instruction surface, and high signal.

## When to update guidance

Update instructions or skills only when at least one is true:

- You repeatedly had to rediscover a durable repo-specific fact.
- Existing instructions were misleading, outdated, incomplete, or contradicted the repo.
- You learned validation, setup, workflow, safety, architecture, or convention details likely to be useful next time.

## Where to put changes

- Shared durable guidance -> the narrowest relevant `AGENTS.md`. Use the root file for truly repo-wide rules, but prefer a nested `AGENTS.md` when guidance applies only to a subtree and would clutter higher-level instructions.
- Pi project skills -> correct the relevant `.pi/skills/**/SKILL.md` when a skill itself is stale, incomplete, or misleading.
- Cross-harness skills -> correct the relevant `.agents/skills/**/SKILL.md` when the repo intentionally shares skills across agents.
- Copilot-specific guidance -> `.github/copilot-instructions.md` or `.github/instructions/*.instructions.md` only when the repo already uses those surfaces and the guidance belongs there.
- Claude shims -> root `CLAUDE.md`, when used as a shim, should remain a short pointer such as `@AGENTS.md`; do not duplicate long guidance into it.
- Deeper docs -> link to them when helpful instead of dumping large documentation into immediate context.

## Non-goals and safety

- Do not add generic advice, one-off task details, secrets, private data, or speculative preferences.
- Do not create nested instructions unless the scope differs meaningfully from parent guidance.
- Prefer correcting or tightening existing guidance over duplicating new text.
- Keep edits concise and actionable.
- If there is no durable improvement, make no file changes and do not respond.

## Checklist

1. Review what you learned during the task and identify only durable, repo-specific facts.
2. Check existing guidance before adding new text; prefer correcting or tightening over duplicating.
3. Choose the narrowest appropriate destination from the list above.
4. Write concise, actionable guidance with links to deeper docs when useful.
5. Validate edited Markdown/frontmatter and ensure no unrelated files were changed.
