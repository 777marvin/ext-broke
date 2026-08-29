<!-- Conventional commit title, e.g. `fix(scope): what changed (BRK-xxx)`. -->

## Summary

What and why - one or two sentences.

## Changes

-

## Verification

- [ ] `npm test` passes (full suite, not only the touched files)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run validate:ui` passes when JSX components changed
- [ ] CHANGELOG.md carries an entry for every user-facing change or fix (in the same commit as the change)
- [ ] README / docs updated wherever behavior or documented claims changed
- [ ] `npm run check:version` passes when package.json, the lockfile or a release tag are touched

## Notes

Known limitations, follow-ups, or review questions.
