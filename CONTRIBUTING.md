# Contributing

Thanks for considering a contribution to broke! This project is small and
deliberate: the following conventions keep it that way.

## Setup

```powershell
npm install
npm run typecheck    # tsc --noEmit
npm test             # tsx --test, pure-function tests
```

Both checks must pass before a change is ready. There are no lint rules
beyond TypeScript itself (`tsconfig.json`).

## What to work on

- Open an issue first for non-trivial changes (bug reports and feature
  requests both welcome, templates exist).
- Planned features with implementation specs live in
  [docs/feats.md](docs/feats.md): check there before proposing something
  new, and update the doc when you implement a spec.
- Keep the honest-numbers culture: savings figures in docs are measured,
  not promised. If you change the pipeline, update the affected docs
  (`docs/overview.md`, `docs/token-saving.md`) and the README.

## Commit conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- Every user-visible change gets a [Keep a Changelog](https://keepachangelog.com/)
  entry in `CHANGELOG.md` under `[Unreleased]`.
- Releases follow [Semantic Versioning](https://semver.org/) with annotated
  tags (`git tag -a vX.Y.Z -m "Release X.Y.Z"`).

## Testing

- New behavior needs regression tests in `tests/` (plain node:test with
  tsx, no framework). Compression passes are pure functions; test them
  on synthetic conversations.
- Test fixtures that look like secrets (`sk-…`, `ghp_…`, `AKIA…`) are fake
  by design, they verify `maskSecrets`. Keep them obviously fake.

## Deploying

The extension deploys into `~/.aider-desk/extensions/broke/` via
`scripts/deploy.ps1` (works from this repo):

```powershell
.\scripts\deploy.ps1 -Category extensions -Name broke -InstallDeps
```

The script refuses a dirty working tree, is atomic (previous installation
is restored on failure), and never copies `.git`, `node_modules`, `.env*`,
`.aider*` or `stats.jsonl`. Roll back with `-FromTag <previous-tag>`.

## Code of conduct

Be constructive. This is a hobby-scale project; maintainers respond as
time allows. No harassment, no entitlement.
