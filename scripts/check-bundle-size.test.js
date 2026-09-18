import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checker = join(root, 'scripts', 'check-bundle-size.js')

function runChecker(args) {
	return spawnSync(process.execPath, [checker, ...args], {
		cwd: root,
		encoding: 'utf8',
	})
}

test('fails when a public export has no reviewed baseline', () => {
	const tempDir = mkdtempSync(join(tmpdir(), 'electron-deck-bundle-size-test-'))
	const baselinePath = join(tempDir, 'baseline.json')
	try {
		const update = runChecker(['--update', '--baseline', baselinePath])
		assert.equal(update.status, 0, update.stderr)

		const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
		assert.ok(baseline['./dock-react'])
		delete baseline['./dock-react']
		writeFileSync(baselinePath, JSON.stringify(baseline))

		const check = runChecker(['--baseline', baselinePath])
		assert.notEqual(check.status, 0)
		assert.match(check.stderr, /new export\(s\) with no baseline entry: \.\/dock-react/)
	}
	finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
})
