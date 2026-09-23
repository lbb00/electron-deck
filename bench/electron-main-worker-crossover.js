#!/usr/bin/env electron
/* global URL, clearTimeout, console, process, setTimeout */
/**
 * Real Electron-main crossover benchmark for the per-frame layout path.
 *
 * It compares the production `dist/layout/index.js` path in three placements:
 * main (authorizeSnapshot -> reconcile -> applyReconciledPlacements), node:worker_threads, and
 * Electron utilityProcess. Authorization and applyReconciledPlacements' ViewHandle sink are
 * always executed in main; helpers receive an already-authorized CleanSnapshot
 * and execute only reconcile. No BrowserWindow is created.
 *
 * Usage (requires explicit GC for comparable RSS baselines):
 *   electron --js-flags=--expose-gc bench/electron-main-worker-crossover.js
 *   DECK_CROSSOVER_OUTPUT=/tmp/crossover.json electron --js-flags=--expose-gc bench/electron-main-worker-crossover.js
 *
 * This models the real main-thread security/apply boundary but not native
 * WebContentsView work: `applyReconciledPlacements` is real production code and its sink is
 * an in-main no-op ViewHandle. Helper loss is also not production-equivalent:
 * its reconcile state would need a replay/recovery protocol before adoption.
 */
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const nowNs = () => process.hrtime.bigint()
const msSince = start => Number(nowNs() - start) / 1e6
const percentile = (values, p) => {
	if (values.length === 0) return null
	const ordered = [...values].sort((a, b) => a - b)
	return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)]
}
const summary = samples => ({
	count: samples.length,
	p50Ms: percentile(samples, 0.5),
	p95Ms: percentile(samples, 0.95),
	p99Ms: percentile(samples, 0.99),
	minMs: percentile(samples, 0),
	maxMs: percentile(samples, 1),
	meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
})
const canonical = value => JSON.stringify(value, (_key, item) => item instanceof Map ? { $map: [...item.entries()] } : item)
const memory = () => {
	const usage = process.memoryUsage()
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers }
}
const numberEnv = (name, fallback, min, max) => {
	const value = Number.parseInt(process.env[name] || String(fallback), 10)
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
const requestedOutputPath = resolve(process.env.DECK_CROSSOVER_OUTPUT || `/tmp/electron-deck-main-worker-crossover-${Date.now()}.json`)

if (!isMainThread && workerData?.role === 'reconcile-worker') {
	const { createInitialState, reconcile } = await import(workerData.layoutEntry)
	let state = createInitialState()
	parentPort.on('message', message => {
		if (message.type === 'reset') {
			state = createInitialState()
			parentPort.postMessage({ type: 'reset' })
			return
		}
		if (message.type === 'reconcile') {
			const result = reconcile(state, message.snapshot)
			state = result.state
			parentPort.postMessage({ type: 'result', id: message.id, state, ops: result.ops })
			return
		}
		if (message.type === 'memory') parentPort.postMessage({ type: 'memory', id: message.id, memory: process.memoryUsage() })
	})
} else if (isMainThread) {
	const main = async () => {
	const { app, utilityProcess } = await import('electron')
	const { createApplyRecorder, waitForExit } = await import('./electron-main-worker-crossover.utility.js')
	const holdFrameworkQuit = event => event.preventDefault()
	app.on('before-quit', holdFrameworkQuit)
	const earlyOutputPath = requestedOutputPath
	if (typeof globalThis.gc !== 'function') {
		const report = { schemaVersion: 1, status: 'fail', outputPath: earlyOutputPath, cases: [], errors: ['Requires Electron --js-flags=--expose-gc so RSS baselines are comparable.'] }
		await mkdir(dirname(earlyOutputPath), { recursive: true })
		await writeFile(earlyOutputPath, JSON.stringify(report, null, 2) + '\n')
		console.error(report.errors[0])
		console.log(JSON.stringify({ outputPath: earlyOutputPath, status: report.status, cases: 0, errors: 1 }))
		app.removeListener('before-quit', holdFrameworkQuit)
		process.exit(2)
	} else {
		const outputPath = earlyOutputPath
		const layoutEntry = process.env.DIST
			? pathToFileURL(resolve(process.env.DIST, 'index.js')).href
			: new URL('../dist/layout/index.js', import.meta.url).href
		const { authorizeSnapshot, reconcile, createInitialState, applyReconciledPlacements } = await import(layoutEntry)
		const viewCounts = [8, 64, 256]
		const scenarios = ['steady', 'moving']
		const frames = numberEnv('DECK_CROSSOVER_FRAMES', 600, 40, 20000)
		const warmupFrames = numberEnv('DECK_CROSSOVER_WARMUP_FRAMES', 100, 10, 5000)
		const trials = numberEnv('DECK_CROSSOVER_TRIALS', 3, 2, 9)
		const burst = numberEnv('DECK_CROSSOVER_BURST', 32, 1, 1024)
		const requestTimeoutMs = numberEnv('DECK_CROSSOVER_REQUEST_TIMEOUT_MS', 15000, 100, 120000)
		const auth = token => ({ viewId: `view-${token.slice(3)}`, layer: Number(token.slice(3)) % 4 })
		const rawFrame = (count, epoch, scenario) => ({
			generation: 1,
			epoch,
			views: Array.from({ length: count }, (_, index) => ({
				viewId: 'untrusted',
				placement: { visible: true, bounds: { x: index * 13 + (scenario === 'moving' ? epoch % 37 : 0), y: index % 11, width: 300, height: 200 } },
				layer: 999,
				extra: { slotToken: `tok${index}` },
			})),
		})
		const inputsFor = (count, scenario, size) => Array.from({ length: size }, (_, epoch) => rawFrame(count, epoch, scenario))
		const expectedFor = inputs => {
			let state = createInitialState()
			return inputs.map(raw => {
				const clean = authorizeSnapshot(raw, auth)
				const result = reconcile(state, clean)
				state = result.state
				const touched = new Set(result.ops.filter(op => op.kind !== 'reorder').map(op => op.viewId))
				return { state: canonical(state), ops: canonical(result.ops), applyCount: touched.size }
			})
		}
		const expectedApplyCount = expected => expected.reduce((total, frame) => total + frame.applyCount, 0)
		const createNodeWorker = async () => {
			const worker = new Worker(new URL(import.meta.url), { workerData: { role: 'reconcile-worker', layoutEntry } })
			const pending = new Map()
			const rejectPending = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }; pending.clear() }
			worker.on('message', message => {
				if (message.type === 'reset') pending.get('reset')?.resolve(message)
				if (message.type === 'result') pending.get(message.id)?.resolve(message)
				if (message.type === 'memory') pending.get(message.id)?.resolve(message)
			})
			worker.on('error', rejectPending)
			worker.on('exit', code => rejectPending(new Error(`worker_threads exited before reply (code ${code})`)))
			const request = message => new Promise((resolvePromise, reject) => {
				const key = message.id ?? 'reset'
				if (pending.has(key)) { reject(new Error(`duplicate pending request: ${key}`)); return }
				const timer = setTimeout(() => { pending.delete(key); reject(new Error(`worker_threads ${message.type} timed out after ${requestTimeoutMs}ms`)) }, requestTimeoutMs)
				pending.set(key, { timer, resolve: value => { clearTimeout(timer); pending.delete(key); resolvePromise(value) }, reject })
				try { worker.postMessage(message) } catch (error) { clearTimeout(timer); pending.delete(key); reject(error) }
			})
			try { await request({ type: 'reset' }) } catch (error) { await worker.terminate(); throw error }
			return { kind: 'worker_threads', pid: process.pid, request, close: async () => { const exited = waitForExit(worker, requestTimeoutMs, 'worker_threads'); await Promise.all([exited, worker.terminate()]) } }
		}
		const createUtilityProcess = async () => {
			const child = utilityProcess.fork(fileURLToPath(new URL('./electron-main-worker-crossover.utility.js', import.meta.url)), [], { env: { ...process.env, DECK_CROSSOVER_LAYOUT_ENTRY: layoutEntry } })
			const pending = new Map()
			const rejectPending = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }; pending.clear() }
			child.on('message', (...args) => {
				const message = args.find(value => value && typeof value === 'object' && typeof value.type === 'string')
				if (!message) return
				if (message.type === 'reset') pending.get('reset')?.resolve(message)
				if (message.type === 'result') pending.get(message.id)?.resolve(message)
				if (message.type === 'memory') pending.get(message.id)?.resolve(message)
			})
			child.on('error', rejectPending)
			child.on('exit', (code, signal) => rejectPending(new Error(`utility_process exited before reply (code ${code}, signal ${signal})`)))
			const request = message => new Promise((resolvePromise, reject) => {
				const key = message.id ?? 'reset'
				if (pending.has(key)) { reject(new Error(`duplicate pending request: ${key}`)); return }
				const timer = setTimeout(() => { pending.delete(key); reject(new Error(`utility_process ${message.type} timed out after ${requestTimeoutMs}ms`)) }, requestTimeoutMs)
				pending.set(key, { timer, resolve: value => { clearTimeout(timer); pending.delete(key); resolvePromise(value) }, reject })
				try { child.postMessage(message) } catch (error) { clearTimeout(timer); pending.delete(key); reject(error) }
			})
			try { await request({ type: 'reset' }) } catch (error) { child.kill(); throw error }
			return { kind: 'utility_process', pid: child.pid, request, close: async () => { const exited = waitForExit(child, requestTimeoutMs, 'utility_process'); child.kill(); await exited } }
		}
		const warm = async (transport, inputs) => {
			for (let id = 0; id < inputs.length; id++) await transport.request({ type: 'reconcile', id: `warm-${id}`, snapshot: authorizeSnapshot(inputs[id], auth) })
			await transport.request({ type: 'reset' })
		}
		const verifyOutcomes = (outcomes, expected, label) => {
			for (const row of outcomes) {
				if (canonical(row.state) !== expected[row.id].state || canonical(row.ops) !== expected[row.id].ops) throw new Error(`${label} final-state mismatch at frame ${row.id}`)
			}
		}
		const runMain = (inputs, applyRecorder) => {
			let state = createInitialState()
			const samples = []
			const outcomes = []
			const activeStarted = nowNs()
			for (let id = 0; id < inputs.length; id++) {
				const started = nowNs()
				const clean = authorizeSnapshot(inputs[id], auth)
				const result = reconcile(state, clean)
				state = result.state
				applyReconciledPlacements(result.ops, state, applyRecorder.resolveApply)
				samples.push(msSince(started))
				outcomes.push({ id, state, ops: result.ops })
			}
			return { transport: 'main', samplesMs: samples, activeElapsedMs: msSince(activeStarted), queuePeak: 0, applyCount: applyRecorder.applyCount(), outcomes }
		}
		const runOffThread = async (factory, inputs, queueLimit) => {
			const transport = await factory()
			try {
				await warm(transport, inputs.slice(0, warmupFrames))
				const applyRecorder = createApplyRecorder()
				const activeStarted = nowNs()
				const samples = []
				const outcomes = []
				const received = []
				const queue = []
				let queuePeak = 0
				for (let id = 0; id < inputs.length; id++) {
					const started = nowNs()
					const snapshot = authorizeSnapshot(inputs[id], auth)
					const pending = transport.request({ type: 'reconcile', id, snapshot }).then(result => {
						applyReconciledPlacements(result.ops, result.state, applyRecorder.resolveApply)
					return { id, state: result.state, ops: result.ops, elapsedMs: msSince(started) }
					})
					queue.push(pending); queuePeak = Math.max(queuePeak, queue.length)
					if (queue.length >= queueLimit) received.push(...await Promise.all(queue.splice(0)))
				}
				received.push(...await Promise.all(queue))
				received.sort((a, b) => a.id - b.id)
				for (const row of received) { samples.push(row.elapsedMs); outcomes.push(row) }
				const activeElapsedMs = msSince(activeStarted)
				const memoryResult = await transport.request({ type: 'memory', id: 'memory' })
				const utilityMetric = transport.kind === 'utility_process' ? app.getAppMetrics().find(metric => metric.pid === transport.pid) : null
				return { transport: transport.kind, helper: { pid: transport.pid, memory: memoryResult.memory, workingSetKiB: utilityMetric?.memory?.workingSetSize ?? null }, samplesMs: samples, activeElapsedMs, queuePeak, applyCount: applyRecorder.applyCount(), outcomes }
			} finally { await transport.close() }
		}
		const report = {
			schemaVersion: 1,
			status: 'running',
			outputPath,
			environment: { electron: process.versions.electron, node: process.versions.node, v8: process.versions.v8, platform: process.platform, arch: process.arch },
			method: { productionLayoutEntry: layoutEntry, frames, warmupFrames, trials, burst, requestTimeoutMs, mainBoundary: 'authorizeSnapshot authorization + applyReconciledPlacements/ViewHandle sink', helperBoundary: 'reconcile only', helperResult: 'This is the naive cut imposed by the current applyReconciledPlacements API: every reply structured-clones the complete ReconcilerState Map plus ops. It is an upper bound for this implementation, not a claim about compact/replay-aware worker designs.', nativeViewBoundary: 'no WebContentsView; production applyReconciledPlacements uses a no-op ViewHandle sink', isolation: 'Every worker_threads and utility_process trial starts a fresh helper process/thread. Main is the Electron measurement host; repeat launcher processes for full main-process isolation.', warmup: 'Each off-thread helper runs warmupFrames then resets. Each main/main-aa placement runs the same number of unrecorded frames from an equally empty apply-sink cache.', aaNoise: 'The main placement runs twice per scenario/trial (main-aa and main); their distribution is retained as an A/A noise control. Strategy order rotates by trial.', comparison: 'Only queueLimit=1 cases are strict serial round-trip comparisons. queueLimit=burst cases are separately labelled backlog experiments and must not be compared as latency/throughput alternatives.', memorySampling: 'Helper process.memoryUsage() is requested once after the timed frames, so it is excluded from each round-trip sample.', rss: 'rss is an instantaneous Electron-main-process snapshot before/after each placement, not post-GC retained memory. utility_process reports its own final process.memoryUsage() separately and is already closed before after is sampled; it is not included in main RSS. worker_threads shares main RSS.' },
			cases: [],
			errors: [],
		}
		try {
			await app.whenReady()
			for (const count of viewCounts) for (const scenario of scenarios) {
				const inputs = inputsFor(count, scenario, frames)
				const expected = expectedFor(inputs)
				for (let trial = 0; trial < trials; trial++) {
					const strict = trial % 3 === 0
						? ['main-aa', 'worker_threads', 'utility_process', 'main']
						: trial % 3 === 1 ? ['worker_threads', 'main-aa', 'main', 'utility_process'] : ['utility_process', 'main', 'worker_threads', 'main-aa']
					const placements = [...strict.map(placement => ({ placement, queueLimit: 1, experiment: 'strict-round-trip' })), { placement: 'worker_threads', queueLimit: burst, experiment: 'burst-backlog' }, { placement: 'utility_process', queueLimit: burst, experiment: 'burst-backlog' }]
					for (const plan of placements) {
						globalThis.gc()
						const before = memory()
						const { placement } = plan
						let result
						if (placement === 'main' || placement === 'main-aa') {
							const warmResult = runMain(inputs.slice(0, warmupFrames), createApplyRecorder())
							verifyOutcomes(warmResult.outcomes, expected.slice(0, warmupFrames), `${placement} warmup`)
							if (warmResult.applyCount !== expectedApplyCount(expected.slice(0, warmupFrames))) throw new Error(`${placement} warmup apply count mismatch`)
							result = runMain(inputs, createApplyRecorder())
						} else if (placement === 'worker_threads') result = await runOffThread(createNodeWorker, inputs, plan.queueLimit)
						else result = await runOffThread(createUtilityProcess, inputs, plan.queueLimit)
						verifyOutcomes(result.outcomes, expected, placement)
						if (result.applyCount !== expectedApplyCount(expected)) throw new Error(`${placement} apply count mismatch`)
						const after = memory()
						const { outcomes: _outcomes, ...measured } = result
						report.cases.push({ count, scenario, trial, placement, experiment: plan.experiment, queueLimit: plan.queueLimit, ...measured, finalStateVerified: true, latency: summary(result.samplesMs), throughputFramesPerSecond: inputs.length / (result.activeElapsedMs / 1000), rss: { before, after, delta: after.rss - before.rss } })
					}
				}
			}
			report.status = 'pass'
		} catch (error) {
			report.status = 'fail'
			report.errors.push(String(error?.stack || error))
		} finally {
			await mkdir(dirname(outputPath), { recursive: true })
				await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
				console.log(JSON.stringify({ outputPath, status: report.status, cases: report.cases.length, errors: report.errors.length }))
				app.removeListener('before-quit', holdFrameworkQuit)
				process.exit(report.status === 'pass' ? 0 : 1)
		}
	}
	}
	void main().catch(async error => {
		const report = { schemaVersion: 1, status: 'fail', outputPath: requestedOutputPath, cases: [], errors: [String(error?.stack || error)] }
		try { await mkdir(dirname(requestedOutputPath), { recursive: true }); await writeFile(requestedOutputPath, JSON.stringify(report, null, 2) + '\n') } catch (writeError) { console.error(`Could not write failure report: ${writeError}`) }
		console.error(report.errors[0])
		process.exit(1)
	})
}
