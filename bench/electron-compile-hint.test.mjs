/* global clearTimeout, setImmediate, setTimeout */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	prepareCoordinator,
	recognitionFromEvents,
	runWorker,
	stageBundles,
} from './electron-compile-hint.mjs'

test('stageBundles sends byte-identical bodies whose only difference is the first line', async () => {
	const root = await mkdtemp(join(tmpdir(), 'electron-compile-hint-stage-'))
	try {
		const staged = await stageBundles(root)
		const control = await readFile(staged.variants.control.bundle)
		const hint = await readFile(staged.variants.hint.bundle)
		assert.equal(staged.invariant.bodyByteIdentical, true)
		assert.deepEqual(control.subarray(control.indexOf(10) + 1), hint.subarray(hint.indexOf(10) + 1))
		assert.ok(staged.targetDiscovery.targetFunctions.length > 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('coordinator preflight creates its output root without starting Electron', async () => {
	const root = await mkdtemp(join(tmpdir(), 'electron-compile-hint-preflight-'))
	try {
		const prepared = await prepareCoordinator(join(root, 'output'))
		assert.equal(prepared.outputRoot, join(root, 'output'))
		assert.equal(prepared.staged.invariant.onlyFirstLineDiffers, true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('recognition excludes same-named function events from another source or offset', () => {
	const targets = {
		control: { url: 'file:///stage/control/app.bundle.js', offsets: { boot: 100 } },
		hint: { url: 'file:///stage/hint/app.bundle.js', offsets: { boot: 101 } },
	}
	const control = [
		'script-details,7,file:///unrelated.js,0,0',
		'function,parse-function,7,100,200,0,0,boot',
		'script-details,8,file:///stage/control/app.bundle.js,0,0',
		'function,parse-function,8,99,200,0,0,boot',
	].join('\n')
	const hint = [
		'script-details,9,file:///unrelated.js,0,0',
		'function,parse-function,9,101,201,0,0,boot',
		'script-details,10,file:///stage/hint/app.bundle.js,0,0',
		'function,parse-function,10,101,201,0,0,boot',
	].join('\n')

	assert.equal(
		recognitionFromEvents(control, hint, ['boot'], targets).status,
		'inconclusive-no-witness',
	)
})

test('coordinator preflight refuses an existing output root without deleting it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'electron-compile-hint-existing-'))
	try {
		const marker = join(root, 'keep-me')
		await writeFile(marker, 'safe')
		await assert.rejects(prepareCoordinator(root), /must not already exist/)
		assert.equal(await readFile(marker, 'utf8'), 'safe')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('a child spawn error settles the worker and leaves a diagnostic log', async () => {
	const root = await mkdtemp(join(tmpdir(), 'electron-compile-hint-spawn-error-'))
	const child = new EventEmitter()
	child.stdout = new EventEmitter()
	child.stderr = new EventEmitter()
	child.kill = () => true
	// The test checks the worker outcome even if the child emits an error.
	child.on('error', () => {})
	const run = runWorker({
		outputRoot: root,
		staged: { variants: { control: { url: 'file:///unused', dir: root } }, targetDiscovery: { targetFunctions: [] } },
		variant: 'control', cacheMode: 'cold', phase: 'diagnostic', sequence: 0,
	}, () => {
		setImmediate(() => child.emit('error', new Error('spawn EACCES')))
		return child
	})
	let deadline
	try {
		const sample = await Promise.race([
			run,
			new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('spawn error did not settle the worker')), 100) }),
		])
		assert.match(sample.outcome.error, /spawn EACCES/)
		assert.equal(sample.result.status, 'missing-result')
		assert.match(await readFile(join(root, 'workers', sample.id, 'electron.log'), 'utf8'), /spawn EACCES/)
	} finally {
		clearTimeout(deadline)
		child.emit('close', null, null)
		await run
		await rm(root, { recursive: true, force: true })
	}
})
