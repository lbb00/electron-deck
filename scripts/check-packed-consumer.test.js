import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const script = join(repo, 'scripts/check-packed-consumer.js')

function run(env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script], {
			cwd: repo,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		child.stdout.on('data', chunk => { output += chunk })
		child.stderr.on('data', chunk => { output += chunk })
		child.once('error', reject)
		child.once('close', (code, signal) => resolve({ code, signal, output }))
	})
}

test('packed consumer smoke runs a real Electron consumer and writes a structured result', async () => {
	const outputDir = await mkdtemp(join(tmpdir(), 'electron-deck-packed-consumer-test-'))
	try {
		const result = await run({ DECK_PACKED_CONSUMER_OUTPUT_DIR: outputDir })
		assert.equal(result.signal, null, result.output)
		assert.equal(result.code, 0, result.output)
		const report = JSON.parse(await (await import('node:fs/promises')).readFile(join(outputDir, 'packed-consumer-result.json'), 'utf8'))
		assert.equal(report.success, true)
		assert.equal(report.packageName, 'electron-deck')
		assert.equal(report.publicEntry, true)
		assert.equal(report.layoutRoundTrip, true)
		assert.equal(report.startElectronDeck, true)
		assert.equal(report.disposed, true)
		assert.equal(report.appQuitRequested, true)
	} finally {
		await rm(outputDir, { recursive: true, force: true })
	}
})

test('bounded command timeout aborts a stuck pack command', async () => {
	const root = await mkdtemp(join(tmpdir(), 'electron-deck-packed-timeout-test-'))
	const fakeBin = join(root, 'bin')
	const fakePnpm = join(fakeBin, 'pnpm')
	const outputDir = join(root, 'output')
	try {
		await (await import('node:fs/promises')).mkdir(fakeBin, { recursive: true })
		await writeFile(fakePnpm, '#!/bin/sh\nsleep 5\n')
		await chmod(fakePnpm, 0o755)
		const result = await run({
			DECK_PACKED_CONSUMER_OUTPUT_DIR: outputDir,
			DECK_PACKED_CONSUMER_TIMEOUT_MS: '50',
			PATH: `${fakeBin}:${process.env.PATH}`,
		})
		assert.notEqual(result.code, 0, result.output)
		assert.match(result.output, /timed out after 50ms/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
