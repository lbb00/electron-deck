#!/usr/bin/env electron
/* global console, process */
/**
 * Browser-renderer crossover probe: local JavaScript versus a standard Web
 * Worker for the same deterministic, CPU-only calculation. This intentionally
 * does not move DOM reads or Electron-native calls into the Worker.
 *
 * Run manually (after `pnpm install`):
 *   DECK_RENDERER_WORKER_OUTPUT=/tmp/renderer-worker.json \
 *     electron bench/electron-renderer-worker-crossover.js
 *
 * The calculation is synthetic. It establishes the serialization/scheduling
 * crossover on this Chromium build; it is not evidence that electron-deck's
 * layout-following path should use a Worker.
 */
import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const outputPath = resolve(process.env.DECK_RENDERER_WORKER_OUTPUT || `/tmp/electron-renderer-worker-crossover-${Date.now()}.json`)
const sampleCount = boundedEnv('DECK_RENDERER_WORKER_SAMPLES', 80, 20, 500)
const warmupCount = boundedEnv('DECK_RENDERER_WORKER_WARMUP', 20, 5, 200)
const responsivenessTasks = boundedEnv('DECK_RENDERER_WORKER_RESPONSIVENESS_TASKS', 64, 8, 128)
const scenarios = [
	{ name: 'small', iterations: 30_000 },
	{ name: 'medium', iterations: 240_000 },
	{ name: 'large', iterations: 1_200_000 },
]

function boundedEnv(name, fallback, min, max) {
	const value = Number.parseInt(process.env[name] || '', 10)
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

const rendererSource = String.raw`<!doctype html><meta charset="utf-8"><title>worker crossover</title><script>
(() => {
  const now = () => performance.now()
  const percentile = (samples, fraction) => {
    if (samples.length === 0) return null
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
  }
  const summarize = (samples, elapsedMs) => ({
    count: samples.length,
    minMs: Math.min(...samples), maxMs: Math.max(...samples),
    p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99),
    throughputPerSecond: samples.length / (elapsedMs / 1000),
  })
  const compute = (iterations, seed) => {
    let x = seed >>> 0
    let sum = 0
    for (let i = 0; i < iterations; i++) {
      x = (Math.imul(x ^ (x >>> 16), 0x45d9f3b) + i) >>> 0
      sum = (sum + (x ^ (x >>> 13))) >>> 0
    }
    return sum >>> 0
  }
  const workerSource =
    'const compute = ' + compute.toString() + ';' +
    'self.onmessage = ({ data }) => { const result = compute(data.iterations, data.seed); self.postMessage({ id: data.id, result }); };'
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  let worker = null
  let nextId = 1
  const pending = new Map()
  const requestTimeoutMs = 5000
  const settlePending = (id, outcome, value) => {
    const request = pending.get(id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(id)
    request[outcome](value)
  }
  const rejectAllPending = error => {
    for (const id of pending.keys()) settlePending(id, 'reject', error)
  }
  const workerRequest = (iterations, seed) => new Promise((resolve, reject) => {
    if (!worker) { reject(new Error('Web Worker is unavailable')); return }
    const id = nextId++
    const timer = setTimeout(() => settlePending(id, 'reject', new Error('Web Worker request ' + id + ' timed out after ' + requestTimeoutMs + 'ms')), requestTimeoutMs)
    pending.set(id, { resolve, reject, timer })
    try { worker.postMessage({ id, iterations, seed }) } catch (error) { settlePending(id, 'reject', error) }
  })
  const startWorker = async () => {
    const startedAt = now()
    worker = new Worker(workerUrl)
    worker.onmessage = ({ data }) => {
      settlePending(data.id, 'resolve', data.result)
    }
    worker.onerror = event => {
      event.preventDefault()
      rejectAllPending(new Error(event.message || 'Web Worker error'))
      worker?.terminate()
      worker = null
    }
    worker.onmessageerror = () => { rejectAllPending(new Error('Web Worker message deserialization failed')); worker?.terminate(); worker = null }
    const handshake = await workerRequest(1, 1)
    if (handshake !== compute(1, 1)) throw new Error('worker startup checksum mismatch')
    return now() - startedAt
  }
  const precomputeRequests = (iterations, count, startSeed) => Array.from({ length: count }, (_, index) => {
    const seed = (startSeed + index * 2654435761) >>> 0
    return { seed, expected: compute(iterations, seed) }
  })
  const one = async (mode, iterations, seed) => {
    const startedAt = now()
    const result = mode === 'worker' ? await workerRequest(iterations, seed) : compute(iterations, seed)
    return { latencyMs: now() - startedAt, result }
  }
  const series = async (mode, scenario, samples, warmup) => {
    // Compute expected checksums before warmup/timing, never in a sample.
    const requests = precomputeRequests(scenario.iterations, warmup + samples, scenario.iterations)
    for (let i = 0; i < warmup; i++) {
      const request = requests[i]
      const value = await one(mode, scenario.iterations, request.seed)
      if (value.result !== request.expected) throw new Error(mode + ' warmup checksum mismatch')
    }
    const startedAt = now()
    const rawLatencyMs = []
    let finalRequest = null
    for (let i = 0; i < samples; i++) {
      const request = requests[warmup + i]
      const value = await one(mode, scenario.iterations, request.seed)
      if (value.result !== request.expected) throw new Error(mode + ' checksum mismatch at sample ' + i)
      rawLatencyMs.push(value.latencyMs)
      finalRequest = { id: i, seed: request.seed, expected: request.expected, actual: value.result, correct: request.expected === value.result }
    }
    return { ...summarize(rawLatencyMs, now() - startedAt), rawLatencyMs, finalRequest }
  }
  const responsiveness = async (mode, scenario, count) => {
    // This deliberately precedes rAF/input scheduling: Worker-mode measurement
    // must not hide a main-thread checksum calculation in its response window.
    const requests = precomputeRequests(scenario.iterations, count, 99)
    const allRafIntervals = []
    const invalidRafIntervalsMs = []
    let lastFrame = null
    let running = true
    const raf = timestamp => {
      if (lastFrame !== null) {
        const interval = timestamp - lastFrame
        if (!Number.isFinite(interval) || interval <= 0) invalidRafIntervalsMs.push(interval)
        else allRafIntervals.push({ startTimestampMs: lastFrame, endTimestampMs: timestamp, intervalMs: interval })
      }
      lastFrame = timestamp
      if (running) requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    // A contiguous local batch deliberately blocks this renderer. The worker
    // batch awaits each reply, giving the renderer a chance to service frames.
    const workStartedAt = now()
    const timerProbe = { scheduledAt: now(), firedAt: null }
    setTimeout(() => { timerProbe.firedAt = now() }, 0)
    let finalRequest = null
    for (let i = 0; i < count; i++) {
      const request = requests[i]
      finalRequest = await one(mode, scenario.iterations, request.seed)
      if (finalRequest.result !== request.expected) throw new Error(mode + ' responsiveness checksum mismatch')
    }
    const workEndedAt = now()
    const workElapsedMs = workEndedAt - workStartedAt
    await new Promise(resolve => setTimeout(resolve, 30))
    running = false
    if (timerProbe.firedAt === null) throw new Error(mode + ' timer probe did not fire')
    const timerFiredInsideWork = timerProbe.firedAt >= workStartedAt && timerProbe.firedAt < workEndedAt
    const timerFiredAfterWork = timerProbe.firedAt >= workEndedAt
    if (mode === 'worker' && !timerFiredInsideWork) throw new Error('worker timer probe did not fire inside the work window')
    if (mode === 'local' && !timerFiredAfterWork) throw new Error('local timer probe fired before the blocking work ended')
    if (invalidRafIntervalsMs.length > 0) throw new Error(mode + ' observed non-positive requestAnimationFrame intervals: ' + invalidRafIntervalsMs.join(','))
    const overlapsWork = interval => interval.startTimestampMs < workEndedAt && interval.endTimestampMs > workStartedAt
    const workRafIntervals = allRafIntervals.filter(overlapsWork)
    if (workRafIntervals.length === 0) throw new Error(mode + ' collected no positive requestAnimationFrame intervals that overlap the work window')
    const workRafIntervalMs = workRafIntervals.map(interval => interval.intervalMs)
    return {
      scenario: scenario.name,
      tasks: count,
      workElapsedMs,
      workWindow: { workStartedAt, workEndedAt },
      pageStateAtWorkStart: { documentHidden: document.hidden, hasFocus: document.hasFocus() },
      timerProbe,
      raf: summarize(workRafIntervalMs, Math.max(1, workRafIntervalMs.reduce((sum, value) => sum + value, 0))),
      allRawRafIntervals: allRafIntervals.map(interval => ({ ...interval, overlapsWorkWindow: overlapsWork(interval) })),
      workWindowRawRafIntervals: workRafIntervals,
      invalidRafIntervalsMs,
      rafTailLatencyInterpretation: workRafIntervals.length >= 100 ? '100 or more work-window rAF intervals collected; percentile estimates are still diagnostic.' : 'Fewer than 100 work-window rAF intervals collected; do not interpret rAF P95/P99 as tail-latency evidence.',
      finalRequest: { expected: requests.at(-1).expected, actual: finalRequest.result, correct: finalRequest.result === requests.at(-1).expected },
      note: 'Input uses a zero-delay timer as an event-loop responsiveness proxy; it is not OS input latency.',
    }
  }
  const memory = () => performance.memory ? {
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
  } : null
  const nextFrame = label => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' did not receive requestAnimationFrame within 2000ms')), 2000)
    requestAnimationFrame(timestamp => { clearTimeout(timer); resolve(timestamp) })
  })
  const requireFrameProgress = async () => {
    const first = await nextFrame('first visible frame')
    const second = await nextFrame('second visible frame')
    if (second <= first) throw new Error('requestAnimationFrame did not advance')
    return { firstTimestampMs: first, secondTimestampMs: second, intervalMs: second - first }
  }
  globalThis.__electronDeckWorkerCrossoverStart = async () => ({ frameProgress: await requireFrameProgress(), startupMs: await startWorker(), rendererMemoryAfterStartup: memory() })
  globalThis.__electronDeckWorkerCrossover = async config => {
    const runs = []
    // local A/A surrounds the worker pass, exposing simple time drift/noise.
    for (const scenario of config.scenarios) {
      const localA = await series('local', scenario, config.samples, config.warmup)
      const workerRun = await series('worker', scenario, config.samples, config.warmup)
      const localB = await series('local', scenario, config.samples, config.warmup)
      runs.push({ scenario, localA, worker: workerRun, localB })
    }
    const large = config.scenarios.find(item => item.name === 'large')
    if (!large) throw new Error('large responsiveness scenario is required')
    const interaction = {
      local: await responsiveness('local', large, config.responsivenessTasks),
      worker: await responsiveness('worker', large, config.responsivenessTasks),
    }
    rejectAllPending(new Error('Web Worker terminated before result'))
    worker?.terminate()
    worker = null
    URL.revokeObjectURL(workerUrl)
    return { renderer: { userAgent: navigator.userAgent, crossOriginIsolated: crossOriginIsolated, memory: memory() }, runs, interaction }
  }
})()
</script>`

const report = {
	schemaVersion: 1,
	status: 'running',
	method: {
		calculation: 'Synthetic deterministic integer hash; calibration only, not an electron-deck layout optimization claim.',
		workerBoundary: 'Standard browser Web Worker with structured-cloned { id, iterations, seed }; no DOM or Electron native API executes in the Worker.',
		latency: 'Each sample measures send-or-local-start through verified result receipt. Runs are serial to measure unqueued end-to-end latency.',
		aa: 'local A then worker then local B, with identical warmup and seed schedule.',
		responsiveness: 'requestAnimationFrame intervals plus a zero-delay input-timer proxy during a bounded large-task batch.',
	},
	config: { sampleCount, warmupCount, responsivenessTasks, scenarios },
	environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, v8: process.versions.v8, node: process.versions.node },
	rss: { meaning: 'Electron app.getAppMetrics renderer-process workingSetSizeKiB. A Web Worker is a thread in that renderer process, so it has no separately attributable RSS.' },
	errors: [],
}

let window = null
let finalizing = false
// Electron can otherwise quit while main() is still waiting for app.whenReady()
// because no BrowserWindow exists yet. Keep the harness alive until finalize()
// has written a terminal report.
const holdAppQuit = event => event.preventDefault()
async function main() {
	await app.whenReady()
	window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
	await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererSource)}`)
	// rAF needs a visible page. showInactive avoids stealing focus from a user.
	window.showInactive()
	const rendererPid = window.webContents.getOSProcessId()
	const before = rendererMetric(rendererPid)
	const startup = await window.webContents.executeJavaScript('globalThis.__electronDeckWorkerCrossoverStart()', true)
	const afterStartup = rendererMetric(rendererPid)
	report.result = await window.webContents.executeJavaScript(`globalThis.__electronDeckWorkerCrossover(${JSON.stringify({ scenarios, samples: sampleCount, warmup: warmupCount, responsivenessTasks })})`, true)
	report.result.startup = startup
	const after = rendererMetric(rendererPid)
	report.rss.rendererProcess = { pid: rendererPid, beforeWorker: before, afterWorkerStartup: afterStartup, afterWorkerTerminationRequestedAndRuns: after }
	report.status = 'pass'
}

function rendererMetric(pid) {
	const metric = app.getAppMetrics().find(item => item.pid === pid)
	return metric ? { workingSetSizeKiB: metric.memory?.workingSetSize ?? null, privateBytesKiB: metric.memory?.privateBytes ?? null, cpuPercent: metric.cpu?.percentCPUUsage ?? null } : null
}

async function finalize(error) {
	if (finalizing) return
	finalizing = true
	if (error) { report.status = 'fail'; report.errors.push(String(error?.stack || error)) }
	try { if (window && !window.isDestroyed()) window.destroy() } catch (closeError) { report.status = 'fail'; report.errors.push(`window cleanup: ${closeError}`) }
	try {
		await mkdir(dirname(outputPath), { recursive: true })
		await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
		console.log(JSON.stringify({ outputPath, status: report.status, errorCount: report.errors.length }))
	} catch (writeError) {
		console.error(`failed to write benchmark report ${outputPath}: ${writeError}`)
		report.status = 'fail'
	}
	app.removeListener('before-quit', holdAppQuit)
	process.exit(report.status === 'pass' ? 0 : 1)
}

app.on('before-quit', holdAppQuit)
void main().then(() => finalize()).catch(error => finalize(error))
