#!/usr/bin/env electron
/**
 * Real-Electron lifecycle probe for WebContentsView ownership and hidden-view
 * policy. This is deliberately bounded and writes JSON outside the repository.
 * It is a measurement harness, not a performance gate.
 */
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startElectronDeck } from '../dist/index.js'


const outputPath = resolve(process.env.DECK_NATIVE_LIFECYCLE_OUTPUT || `/tmp/electron-deck-native-lifecycle-${Date.now()}.json`)
const tracePath = `${outputPath}.trace.log`
const trace = (stage, details = '') => { try { appendFileSync(tracePath, `[${new Date().toISOString()}] ${stage}${details ? ` ${details}` : ''}\n`) } catch {} }
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
export async function withTimeout(promise, ms, label) {
	let timer
	try { return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })]) }
	finally { clearTimeout(timer) }
}
const source = { url: pathToFileURL(resolve(new URL('../examples/layout-demo/block.html', import.meta.url).pathname)).href }
const report = {
	schemaVersion: 1,
	outputPath,
	status: 'running',
	scenarios: [],
	metrics: [],
	backgroundThrottling: { status: 'unmeasured', observations: [], note: 'backgroundThrottling applies to every WebContents in its host window; one bounded run cannot prove a performance improvement' },
	errors: [],
}
let windows = []
let startedHandle = null
let finalizing = false
const holdFrameworkQuit = (event) => event.preventDefault()
const now = () => Number(process.hrtime.bigint()) / 1e6
const metricRows = () => app.getAppMetrics().map(m => ({
	pid: m.pid,
	creationTime: m.creationTime,
	memory: { workingSetSizeKiB: m.memory?.workingSetSize ?? null },
	cpu: { percentCPUUsage: m.cpu?.percentCPUUsage ?? null },
}))
async function checkpoint(label, roles = []) {
	const startAtMs = now()
	const start = metricRows()
	await wait(50)
	const endAtMs = now()
	const end = metricRows()
	const byPid = new Map(end.map(row => [row.pid, row]))
	const roleMap = new Map()
	for (const role of roles) {
		if (!role?.pid) continue
		const list = roleMap.get(role.pid) || []
		list.push(role.role)
		roleMap.set(role.pid, list)
	}
	report.metrics.push({ label, interval: { startAtMs, endAtMs, durationMs: endAtMs - startAtMs }, processes: start.map(row => ({ ...row, roles: roleMap.get(row.pid) || [], end: byPid.get(row.pid) || null, cpuIntervalAveragePercent: byPid.get(row.pid)?.cpu.percentCPUUsage ?? null })) })
}
function destroyedPromise(wc) {
	if (wc.isDestroyed()) return Promise.resolve(0)
	const t = now()
	return new Promise(resolve => wc.once('destroyed', () => resolve(now() - t)))
}
function scenario(name, status, details = {}) { report.scenarios.push({ name, status, ...details }) }
export function validateLifecycleReport(value) {
	const required = ['show-hide-show', 'cross-window-moveTo', 'session-dispose', 'keepAlive-lru-eviction']
	const errors = []
	if (!value || value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
	for (const name of required) {
		const row = value?.scenarios?.find(s => s.name === name)
		if (!row) errors.push(`missing scenario: ${name}`)
		else if (row.status !== 'pass') errors.push(`scenario failed: ${name}`)
	}
	if (!Array.isArray(value?.metrics) || value.metrics.length === 0) errors.push('metrics must contain at least one checkpoint')
	return errors
}
export function lifecycleExitCode(status) {
	return status === 'pass' ? 0 : 1
}
export function isComparableBackgroundObservation(observation) {
	return observation?.default === true && observation?.manuallyDisabledAfter === false && observation?.hostWindow?.default !== observation?.hostWindow?.disabled && observation?.comparable === true
}
export const loadWebContents = async (wc, timeoutMs = 5000) => {
	if (!wc.isLoading()) return { status: 'already-loaded' }
	return new Promise((resolve, reject) => {
		let timer
		const cleanup = () => { wc.removeListener('did-finish-load', done); wc.removeListener('did-fail-load', fail); wc.removeListener('destroyed', dead) }
		const done = () => { clearTimeout(timer); cleanup(); resolve({ status: 'loaded' }) }
		const fail = (_event, code, description) => { clearTimeout(timer); cleanup(); reject(new Error(`load failed (${code}): ${description}`)) }
		const dead = () => { clearTimeout(timer); cleanup(); reject(new Error('webContents destroyed while loading')) }
		wc.once('did-finish-load', done); wc.once('did-fail-load', fail); wc.once('destroyed', dead)
		timer = setTimeout(() => { cleanup(); reject(new Error(`webContents load timed out after ${timeoutMs}ms`)) }, timeoutMs)
	})
}
export async function measureHiddenTimer(wc, durationMs = 5000) {
	await loadWebContents(wc)
	const wallStart = now()
	const count = await wc.executeJavaScript(`new Promise(resolve => { let count = 0; const start = performance.now(); const timer = setInterval(() => { count += 1; if (performance.now() - start >= ${durationMs}) { clearInterval(timer); resolve(count) } }, 50) })`)
	return { count, wallElapsedMs: now() - wallStart }
}
async function main() {
	trace('main:start')
	const started = startElectronDeck({
		app: { window: { width: 640, height: 420, show: false }, source },
		backend: {
			async assemble(runtime) {
				trace('assemble:start')
				const main = runtime.windows.main
				if (!main) throw new Error('runtime.windows.main unavailable')
				const secondary = runtime.windows.create({ source, width: 640, height: 420, autoTrust: true })
				windows = [main.window, secondary.window]
				for (const win of windows) { win.showInactive(); win.hide() }
				await checkpoint('after-window-create', [{ role: 'main-control', pid: main.controlWc.getOSProcessId() }, { role: 'secondary-control', pid: secondary.controlWc.getOSProcessId() }])

				const first = runtime.view({ source })
				const firstWc = first.webContents
				first.placeIn(main.window, { zone: 0 }).applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 300, height: 200 } })
				trace('first:load-wait')
				await loadWebContents(firstWc)
				trace('first:loaded')
				const firstPid = firstWc.getOSProcessId()
				const defaultThrottle = typeof firstWc.getBackgroundThrottling === 'function' ? firstWc.getBackgroundThrottling() : null
				const rounds = Number.parseInt(process.env.DECK_NATIVE_LIFECYCLE_ROUNDS || '20', 10)
				const hiddenDwellMs = Math.max(20, Math.min(1000, Number.parseInt(process.env.DECK_NATIVE_HIDDEN_DWELL_MS || '40', 10)))
				const roundResults = []
				for (let round = 0; round < Math.max(1, Math.min(rounds, 100)); round++) {
					first.applyPlacement({ visible: false }); const hiddenAt = now()
					await wait(hiddenDwellMs)
					const showStart = now(); first.applyPlacement({ visible: true, bounds: { x: 10 + round, y: 10, width: 320, height: 220 } })
					const restored = !firstWc.isDestroyed() && first.bounds()?.width === 320
					roundResults.push({ round, hiddenDurationMs: now() - hiddenAt, restoreMs: now() - showStart, restored })
					if (round % 5 === 0) await checkpoint(`show-hide-round-${round}`, [{ role: 'main-control', pid: main.controlWc.getOSProcessId() }, { role: 'secondary-control', pid: secondary.controlWc.getOSProcessId() }, { role: 'native-first', pid: firstPid }])
				}
				scenario('show-hide-show', roundResults.every(r => r.restored) ? 'pass' : 'fail', { pid: firstPid, rounds: roundResults, hiddenDwellMs, backgroundThrottling: defaultThrottle })

				const sourceChildrenBefore = main.window.contentView.children.length
				const destChildrenBefore = secondary.window.contentView.children.length
				const moveStart = now()
				await first.moveTo(secondary.window, { zone: 1 })
				const movedBounds = first.bounds()
				const sourceChildrenAfter = main.window.contentView.children.length
				const destChildrenAfter = secondary.window.contentView.children.length
				scenario('cross-window-moveTo', movedBounds && !firstWc.isDestroyed() && destChildrenAfter > destChildrenBefore && sourceChildrenAfter < sourceChildrenBefore ? 'pass' : 'fail', { elapsedMs: now() - moveStart, pid: firstPid, bounds: movedBounds, ownerEvidence: { sourceChildrenBefore, sourceChildrenAfter, destChildrenBefore, destChildrenAfter, destinationVisible: movedBounds?.width > 0 && movedBounds?.height > 0 } })

				const session = runtime.scopes.create()
				const sessionView = runtime.view({ source, scope: session })
				const sessionWc = sessionView.webContents
				sessionView.placeIn(main.window, { zone: 2 }).applyPlacement({ visible: true, bounds: { x: 20, y: 20, width: 200, height: 150 } })
				trace('session:load-wait'); await loadWebContents(sessionWc); trace('session:loaded')
				const destroyed = destroyedPromise(sessionWc)
				const sessionStart = now(); await withTimeout(session.dispose(), 5000, 'session dispose'); const sessionDisposeMs = now() - sessionStart
				const destroyedMs = await Promise.race([destroyed, wait(500).then(() => null)])
				scenario('session-dispose', sessionWc.isDestroyed() ? 'pass' : 'fail', { disposeMs: sessionDisposeMs, webContentsDestroyedMs: destroyedMs })

				const lruA = runtime.view({ source, keepAlive: { policy: 'lru', max: 1 } })
				const lruB = runtime.view({ source, keepAlive: { policy: 'lru', max: 1 } })
				const lruAWc = lruA.webContents
				const lruBWc = lruB.webContents
				lruA.placeIn(secondary.window, { zone: 3 }).applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } })
				lruB.placeIn(secondary.window, { zone: 4 }).applyPlacement({ visible: true, bounds: { x: 110, y: 0, width: 100, height: 100 } })
				trace('lru:load-wait'); await Promise.all([loadWebContents(lruAWc), loadWebContents(lruBWc)]); trace('lru:loaded')
				lruA.applyPlacement({ visible: false }); lruB.applyPlacement({ visible: false }); await wait(100)
				const firstDestroyed = lruAWc.isDestroyed()
				const secondDestroyed = lruBWc.isDestroyed()
				scenario('keepAlive-lru-eviction', firstDestroyed && !secondDestroyed ? 'pass' : 'fail', { firstDestroyed, secondDestroyed })

				const disabled = runtime.view({ source })
				const disabledThrottle = typeof disabled.webContents.getBackgroundThrottling === 'function' ? disabled.webContents.getBackgroundThrottling() : null
				if (typeof disabled.webContents.setBackgroundThrottling === 'function') disabled.webContents.setBackgroundThrottling(false)
				const afterDisabled = typeof disabled.webContents.getBackgroundThrottling === 'function' ? disabled.webContents.getBackgroundThrottling() : null
				disabled.placeIn(secondary.window, { zone: 5 }).applyPlacement({ visible: true, bounds: { x: 0, y: 110, width: 100, height: 100 } })
				const timerMs = Number.parseInt(process.env.DECK_NATIVE_TIMER_MS || '5000', 10)
				await first.moveTo(main.window, { zone: 6 })
				first.applyPlacement({ visible: false }); disabled.applyPlacement({ visible: false })
				let timerDefault = null; let timerDisabled = null
				try { [timerDefault, timerDisabled] = await Promise.all([measureHiddenTimer(firstWc, timerMs), measureHiddenTimer(disabled.webContents, timerMs)]) } catch (error) { report.errors.push(`background timer: ${error}`) }
				const isolated = defaultThrottle === true && afterDisabled === false
				report.backgroundThrottling = { status: isolated && timerDefault && timerDisabled ? 'measured' : 'unmeasurable', observations: [{ default: defaultThrottle, manuallyDisabledBefore: disabledThrottle, manuallyDisabledAfter: afterDisabled, hostWindow: { default: 'main', disabled: 'secondary' }, timerDurationMs: timerMs, hiddenTimerCallbacks: { default: timerDefault, disabled: timerDisabled }, comparable: isolated && !!timerDefault && !!timerDisabled }], note: 'The two measurements use different host windows. Timer callback counts do not establish a general CPU performance improvement; the setting affects every WebContents in its host window.' }
				await checkpoint('after-lifecycle-scenarios', [{ role: 'main-control', pid: main.controlWc.getOSProcessId() }, { role: 'secondary-control', pid: secondary.controlWc.getOSProcessId() }, { role: 'native-first', pid: firstPid }, { role: 'native-disabled', pid: disabled.webContents.getOSProcessId() }])
				await withTimeout(first.dispose(), 5000, 'first view dispose'); await withTimeout(lruB.dispose(), 5000, 'lru view dispose'); await withTimeout(disabled.dispose(), 5000, 'disabled view dispose')
			},
		},
	})
	startedHandle = started
	trace('ready:wait')
	await withTimeout(started.ready, Number.parseInt(process.env.DECK_NATIVE_READY_TIMEOUT_MS || '60000', 10), 'runtime ready')
	trace('ready:resolved')
	await checkpoint('ready')
	await withTimeout(started.dispose(), 10000, 'runtime dispose')
	trace('runtime:disposed')
	await wait(100)
	report.status = validateLifecycleReport(report).length === 0 ? 'pass' : 'fail'
}
async function finalize(error) {
	if (finalizing) return
	finalizing = true
	if (error) { trace('main:fail', String(error)); report.status = 'fail'; report.errors.push(String(error?.stack || error)) }
	try { if (startedHandle) await withTimeout(startedHandle.dispose(), 5000, 'finally runtime cleanup') } catch (cleanupError) { report.status = 'fail'; report.errors.push(`runtime cleanup: ${cleanupError}`) }
	try { for (const win of windows) if (!win.isDestroyed()) win.destroy() } catch (cleanupError) { report.status = 'fail'; report.errors.push(`window cleanup: ${cleanupError}`) }
	await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
	console.log(JSON.stringify({ outputPath, status: report.status, scenarios: report.scenarios.map(s => [s.name, s.status]), errors: report.errors.length }))
	app.removeListener('before-quit', holdFrameworkQuit)
	process.exit(lifecycleExitCode(report.status))
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	app.on('before-quit', holdFrameworkQuit)
	void main().then(() => finalize()).catch(error => finalize(error))
}
