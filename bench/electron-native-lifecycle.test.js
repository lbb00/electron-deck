import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
const withTimeout = async (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))])
const lifecycleExitCode = status => status === 'pass' ? 0 : 1
const loadWebContents = async (wc, timeoutMs = 5000) => {
	if (!wc.isLoading()) return { status: 'already-loaded' }
	return withTimeout(new Promise((resolve, reject) => {
		const cleanup = () => { wc.removeListener('did-finish-load', done); wc.removeListener('did-fail-load', fail); wc.removeListener('destroyed', dead) }
		const done = () => { cleanup(); resolve({ status: 'loaded' }) }
		const fail = (_event, code, description) => { cleanup(); reject(new Error(`load failed (${code}): ${description}`)) }
		const dead = () => { cleanup(); reject(new Error('webContents destroyed while loading')) }
		wc.once('did-finish-load', done); wc.once('did-fail-load', fail); wc.once('destroyed', dead)
	}), timeoutMs, 'webContents load')
}
const isComparableBackgroundObservation = observation => observation?.default === true && observation?.manuallyDisabledAfter === false && observation?.hostWindow?.default !== observation?.hostWindow?.disabled && observation?.comparable === true
const validateLifecycleReport = value => {
	const names = ['show-hide-show', 'cross-window-moveTo', 'session-dispose', 'keepAlive-lru-eviction']
	return names.flatMap(name => !value?.scenarios?.find(s => s.name === name) ? [`missing scenario: ${name}`] : value.scenarios.find(s => s.name === name).status !== 'pass' ? [`scenario failed: ${name}`] : []).concat(value?.metrics?.length ? [] : ['metrics must contain at least one checkpoint'])
}

test('native lifecycle bench declares the complete observable scenario contract', async () => {
	const file = resolve(new URL('./electron-native-lifecycle.js', import.meta.url).pathname)
	const source = await readFile(file, 'utf8')
	for (const marker of [
		'app.getAppMetrics()',
		'getBackgroundThrottling',
		'moveTo(',
		'keepAlive',
		'session.dispose',
		'webContentsDestroyedMs',
		'creationTime',
		'outputPath',
		'examples/layout-demo/block.html',
		'process.exit(lifecycleExitCode(report.status))',
		'void main().then(() => finalize()).catch(error => finalize(error))',
		"app.on('before-quit', holdFrameworkQuit)",
		"app.removeListener('before-quit', holdFrameworkQuit)",
		'if (finalizing) return',
		'session:load-wait',
		'lru:load-wait',
		'DECK_NATIVE_HIDDEN_DWELL_MS',
		'DECK_NATIVE_READY_TIMEOUT_MS || \'60000\'',
	]) assert.equal(source.includes(marker), true, `missing marker: ${marker}`)
})

test('lifecycle report validator rejects missing or failed behavior', () => {
	const base = {
		schemaVersion: 1,
		metrics: [{ label: 'ready' }],
		scenarios: [
			{ name: 'show-hide-show', status: 'pass' },
			{ name: 'cross-window-moveTo', status: 'pass' },
			{ name: 'session-dispose', status: 'pass' },
			{ name: 'keepAlive-lru-eviction', status: 'pass' },
		],
	}
	assert.deepEqual(validateLifecycleReport(base), [])
	assert.match(validateLifecycleReport({ ...base, scenarios: base.scenarios.slice(1) }).join(';'), /missing scenario/)
	assert.match(validateLifecycleReport({ ...base, scenarios: base.scenarios.map(s => s.name === 'session-dispose' ? { ...s, status: 'fail' } : s) }).join(';'), /scenario failed: session-dispose/)
})

test('failed lifecycle report has a non-zero Electron exit code', () => {
	assert.equal(lifecycleExitCode('pass'), 0)
	assert.equal(lifecycleExitCode('fail'), 1)
	assert.equal(lifecycleExitCode('running'), 1)
})

test('timeout helpers fail closed and load failures are reported', async () => {
	await assert.rejects(withTimeout(new Promise(() => {}), 5, 'synthetic stage'), /synthetic stage timed out/)
	const wc = new EventEmitter()
	wc.isLoading = () => true
	const pending = loadWebContents(wc, 50)
	wc.emit('did-fail-load', {}, -105, 'synthetic failure')
	await assert.rejects(pending, /load failed \(-105\)/)
})

test('background comparison requires isolated host windows and explicit toggle states', () => {
	const valid = { default: true, manuallyDisabledAfter: false, hostWindow: { default: 'main', disabled: 'secondary' }, comparable: true }
	assert.equal(isComparableBackgroundObservation(valid), true)
	assert.equal(isComparableBackgroundObservation({ ...valid, hostWindow: { default: 'secondary', disabled: 'secondary' } }), false)
	assert.equal(isComparableBackgroundObservation({ ...valid, manuallyDisabledAfter: null }), false)
})
