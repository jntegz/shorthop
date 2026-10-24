# Contributing to Shorthop

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome. Shorthop is a personal project, so a reply can take a few days.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/jntegz/shorthop/issues/new/choose) and pick the form that fits. Say which version you run and how you installed it (the Deploy to Cloudflare button or `npm run setup`).

**Never paste secrets** into an issue: passwords, API keys, tokens, `.dev.vars`, or Access AUD tags. Replace your own domains and emails with `example.com` if you'd rather keep them private.

**Security problems** don't go in issues. Report them privately as [SECURITY.md](SECURITY.md) describes.

## Working on the code

You need Node.js 22.12 or newer. You don't need a Cloudflare account for local development.

```sh
git clone https://github.com/jntegz/shorthop.git
cd shorthop
npm ci
npm run setup -- local        # writes .dev.vars with random dev secrets
npm run db:migrate:local
npm run seed:dev              # optional: sample links and 120 days of fake stats
npm run dev                   # http://localhost:5173/_admin/
```

The [README](README.md#local-development) has more on local development and the [project layout](README.md#project-layout).

## Before you open a pull request

Run what CI runs:

```sh
npm run typecheck
npm test
SHORTHOP_ALLOW_EXAMPLE_CONFIG=1 npm run build
```

Then:

- **Keep it focused.** One change per pull request is easier to review. For something large, open an issue first so we can agree on the approach.
- **Add tests** for new behaviour or a fixed bug, next to the existing ones in `test/`.
- **Every API route needs a permission rule** in `src/worker/permissions.ts`; a test fails until it has one.
- **Config changes go in the template.** `wrangler.example.jsonc` and `wrangler.toml` are generated: edit `scripts/setup/template.ts`, then run `npm run config:example` and `npm run types`.
- **Database changes** are a new file in `migrations/`; never edit one that has shipped.
- **Note user-facing changes** under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md), with upgrade steps if people need to do something.
- **Update the docs** ([docs/SETUP.md](docs/SETUP.md), the README) when setup or behaviour changes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
