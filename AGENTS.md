# Repository Guidance

This repository is a pi package whose extension sources are loaded directly by pi; there is no build output to commit or publish.

Before committing changes, run:

```bash
npm run format
npm run check
npm pack --dry-run
```

Use the `npm pack --dry-run` output to confirm the package ships only the intended package files. Keep pi core packages such as `@earendil-works/pi-coding-agent` as peer dependencies; add third-party runtime imports to `dependencies` because installed pi packages cannot rely on dev dependencies.

When changing digivolution behavior or prompts, keep the extension prompt, bundled `skills/digivolution/SKILL.md`, and README command/behavior docs consistent.
