# Changesets

This directory contains release notes for changes that have not been published yet. Each Markdown file describes a change and identifies its patch, minor, or major version impact.

## Changes that affect consumers

Run this command in your PR branch:

```bash
pnpm changeset
```

Choose the version impact and write a plain-English description when prompted. Commit the generated `.changeset/xxx.md` file with the code. Internal implementation changes, tests, or documentation changes that do not affect consumers do not need a Changeset.

Write Changesets and release notes in English, the project's primary language. The localized `README.zh-CN.md` remains in Chinese. Run `pnpm check:maintainer-language` to check default documentation and release notes; this check also runs in `pnpm test` and CI.

## Language requirements

| Content                                                      | Requirement          | Check                            |
| ------------------------------------------------------------ | -------------------- | -------------------------------- |
| Changesets, changelog, and default maintenance documentation | English              | `pnpm check:maintainer-language` |
| `README.zh-CN.md` and its language-switch label              | Chinese localization | Excluded from the English check  |

## What happens after merging

1. When a PR with a Changeset merges into main, `changesets/action` opens a **Version Packages** PR. It updates `package.json`, collects the notes into `CHANGELOG.md`, and consumes the processed `.changeset/*.md` files.
2. Merging that version PR runs the release workflow: build, full tests, publish to npm with provenance, create tags, and create a GitHub Release.

A release therefore requires two PR merges. The version PR gives reviewers a chance to check the version and changelog before publishing.

Publishing uses npm trusted publishing (OIDC), with no long-lived npm token in the repository. The release script is `scripts/release.js`, and the workflow is `.github/workflows/release.yml`.
