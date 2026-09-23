import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { publishTagForVersion } from './release-tag.js'

test('a beta is published under beta, leaving latest for stable releases', () => {
	assert.equal(publishTagForVersion('1.0.0-beta.0'), 'beta')
	assert.equal(publishTagForVersion('1.0.0-beta.1'), 'beta')
})

test('stable and other prerelease versions use their own dist-tags', () => {
	assert.equal(publishTagForVersion('0.2.1'), 'latest')
	assert.equal(publishTagForVersion('1.0.0'), 'latest')
	assert.equal(publishTagForVersion('1.0.0-rc.2'), 'rc')
})

test('a prerelease cannot publish under latest', () => {
	assert.throws(() => publishTagForVersion('1.0.0-1'), /Unsupported prerelease/)
	assert.throws(() => publishTagForVersion('1.0.0-latest.0'), /cannot use latest/)
	assert.throws(() => publishTagForVersion('1.0.0-Latest.0'), /cannot use latest/)
})

test('the release command publishes a beta under beta with provenance', () => {
	const dir = mkdtempSync(join(tmpdir(), 'electron-deck-release-'))
	try {
		const scripts = join(dir, 'scripts')
		const bin = join(dir, 'bin')
		const callsFile = join(dir, 'calls.jsonl')
		mkdirSync(scripts)
		mkdirSync(bin)
		copyFileSync(new URL('./release.js', import.meta.url), join(scripts, 'release.js'))
		copyFileSync(new URL('./release-tag.js', import.meta.url), join(scripts, 'release-tag.js'))
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'electron-deck', version: '1.0.0-beta.0', type: 'module' }))
		writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\nprocess.exit(1)\n', { mode: 0o755 })
		writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.RELEASE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o755 })

		const result = spawnSync(process.execPath, [join(scripts, 'release.js')], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, RELEASE_CALLS: callsFile },
		})
		assert.equal(result.status, 0, result.stderr)
		const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse)
		assert.deepEqual(calls, [
			['publish', '--access', 'public', '--provenance', '--tag', 'beta', '--no-git-checks'],
			['exec', 'changeset', 'git-tag'],
		])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
