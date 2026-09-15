#!/usr/bin/env node
/**
 * The publish step that `changesets/action` runs via `publish-script`.
 *
 * Two reasons this is a script instead of a plain `changeset publish`:
 *
 *   1. Provenance. `changeset publish` shells out to `pnpm publish` without
 *      `--provenance`, and pnpm ignores `NPM_CONFIG_PROVENANCE`. Adopting it
 *      as-is would silently drop the SLSA attestation that 0.2.0 and 0.2.1
 *      already carry on the registry. Publishing here keeps the flag.
 *   2. Idempotency. The action runs this script on every push to main that
 *      carries no changesets, so it has to be a no-op once the current version
 *      is already on the registry.
 *
 * `changeset git-tag` still runs at the end: it creates the tag AND writes the
 * `git-tag` events to $CHANGESETS_OUTPUT, which is what the action reads to
 * push tags and cut GitHub Releases. Dropping it would mean no tags, no
 * releases.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const { name, version } = pkg

/** Runs a command with inherited stdio and returns its exit code. */
function run(cmd, args) {
	const res = spawnSync(cmd, args, { stdio: 'inherit' })
	if (res.error) throw res.error
	return res.status ?? 1
}

// `npm view <pkg>@<version>` exits non-zero when that exact version is not on
// the registry yet. A registry outage also lands here, and then the publish
// below fails loudly rather than skipping silently.
const published = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
	stdio: 'ignore',
})

if (published.status === 0) {
	console.log(`[release] ${name}@${version} is already published — skipping publish`)
}
else {
	console.log(`[release] publishing ${name}@${version}`)
	const code = run('pnpm', [
		'publish',
		'--access',
		'public',
		'--provenance',
		'--no-git-checks',
	])
	if (code !== 0) process.exit(code)
}

// Tags whatever is untagged and reports it. Versions that already have a tag
// are skipped rather than failing, so this is safe on a run that published
// nothing — and it repairs a run that published but died before tagging.
process.exit(run('pnpm', ['exec', 'changeset', 'git-tag']))
