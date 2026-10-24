## What this changes

<!-- What and why. Link the issue it fixes, if there is one: "Fixes #123". -->

## Checklist

- [ ] `npm run typecheck`, `npm test` and `SHORTHOP_ALLOW_EXAMPLE_CONFIG=1 npm run build` pass
- [ ] Tests cover the change
- [ ] User-facing changes are under `[Unreleased]` in CHANGELOG.md, with upgrade steps if needed
- [ ] Docs updated (README, docs/SETUP.md) if setup or behaviour changed
- [ ] Config changes made in `scripts/setup/template.ts`, then `npm run config:example`
- [ ] No secrets, real domains or personal emails in code, tests or screenshots
