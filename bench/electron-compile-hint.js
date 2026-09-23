#!/usr/bin/env node
/* global Buffer, clearTimeout, console, process, setTimeout */
/**
 * Real-Electron experiment for V8's file-level explicit compile hint.
 *
 * The coordinator is run with Node and starts short-lived Electron workers.
 * Each worker loads a staged copy of the current dockable-demo HTML through
 * file://.  The two staged app.bundle.js files have byte-identical bodies: the
 * first line is respectively a neutral comment and
 * //# allFunctionsCalledOnLoad.  The repository's demo source and bundle are
 * never written.
 *
 * Usage (after pnpm build && node examples/dockable-demo/bundle.js):
 *   node bench/electron-compile-hint.js
 *   DECK_COMPILE_HINT_OUTPUT=/tmp/compile-hint node bench/electron-compile-hint.js
 *
 * The first two workers are a recognition gate.  They use V8 function-event
 * logging and require at least one control-only lazy parse among functions in
 * this bundle before timing samples are allowed.  A failed gate is a no-go,
 * not a performance result.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DEMO = join(REPO, 'examples', 'dockable-demo')
const SOURCE_BUNDLE = join(DEMO, 'app.bundle.js')
const SOURCE_HTML = join(DEMO, 'index.html')
const ELECTRON = join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const HINT = '//# allFunctionsCalledOnLoad'
const CONTROL = '// no explicit compile hint'
// Candidates are checked against the final staged bundle before the workers
// start. Do not assume source-map names survive a future minifier setting.
const TARGET_FUNCTION_CANDIDATES = ['makeTree', 'makeRegistry', 'renderDomPanel', 'makeBindNativeSlot', 'mountDock', 'boot']
const DEFAULT_SAMPLES_PER_VARIANT = 4
const DEFAULT_TIMEOUT_MS = 45_000

const now = () => Number(process.hrtime.bigint()) / 1e6
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const ensure = (condition, message) => { if (!condition) throw new Error(message) }
const envNumber = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
	const raw = process.env[name]
	if (raw === undefined) return fallback
	const value = Number.parseInt(raw, 10)
	ensure(Number.isInteger(value) && value >= min && value <= max, `${name} must be an integer in [${min}, ${max}]`)
	return value
}

function parseFunctionEvents(text) {
	const rows = []
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith('function,')) continue
		const fields = line.split(',')
		rows.push({ raw: line, kind: fields[1] || null, sourceId: fields[2] || null, startOffset: Number(fields[3]), endOffset: Number(fields[4]), name: fields.at(-1) || null })
	}
	return rows
}

function sourceIdsForUrl(text, url) {
	return new Set(text.split(/\r?\n/).flatMap((line) => {
		const fields = line.split(',')
		return fields[0] === 'script-details' && fields[2] === url ? [fields[1]] : []
	}))
}

export function recognitionFromEvents(controlText, hintText, targetFunctions, targets) {
	const byName = (text, variant) => {
		const sourceIds = sourceIdsForUrl(text, targets[variant].url)
		return Object.fromEntries(targetFunctions.map((name) => [name, parseFunctionEvents(text).filter((row) => row.name === name && sourceIds.has(row.sourceId) && row.startOffset === targets[variant].offsets[name])]))
	}
	const control = byName(controlText, 'control')
	const hint = byName(hintText, 'hint')
	const controlLazyWitnesses = targetFunctions.flatMap((name) => {
		const controlLazy = control[name].filter((row) => row.kind === 'parse-function')
		const hintLazy = hint[name].filter((row) => row.kind === 'parse-function')
		return controlLazy.length > 0 ? [{ name, controlLazy, hintLazy, hintEvents: hint[name] }] : []
	})
	const recognized = controlLazyWitnesses.filter(({ hintLazy }) => hintLazy.length === 0)
	const unrecognized = controlLazyWitnesses.filter(({ hintLazy }) => hintLazy.length > 0)
	const status = recognized.length > 0 ? 'recognized' : unrecognized.length > 0 ? 'unrecognized' : 'inconclusive-no-witness'
	return {
		status,
		targetFunctions,
		// Retain only diagnosis-sized evidence. Events are first bound to the
		// staged bundle's script URL, source id, and exact function offset.
		// Complete function-event text stays in each worker's log file.
		witnesses: { recognized: recognized.map(({ name, controlLazy }) => ({ name, controlLazyCount: controlLazy.length })), unrecognized: unrecognized.map(({ name, controlLazy, hintLazy }) => ({ name, controlLazyCount: controlLazy.length, hintLazyCount: hintLazy.length })) },
		observedTargetEvents: Object.fromEntries(targetFunctions.map((name) => [name, { control: control[name].map((row) => row.kind), hint: hint[name].map((row) => row.kind) }])),
	}
}

function stagedPreload() {
	// The production bundle expects its normal preload bridge.  This minimal
	// harness bridge deliberately makes no native view placement: it preserves
	// the real browser bundle's startup work while keeping this experiment about
	// JS compilation rather than deck host activity.
	return `import { contextBridge, ipcRenderer } from 'electron'\nconst noop = () => {}\ncontextBridge.exposeInMainWorld('__electronDeckLayoutBridge', { version: '1.0.0', subscribe: noop, sendSnapshot: noop, onSlotGrant: () => noop })\ncontextBridge.exposeInMainWorld('__demoControl', { openProject: noop, ready: () => ipcRenderer.send('compile-hint:ready'), onComposite: noop, sendCompositeResult: noop })\n`
}

export async function stageBundles(outputRoot) {
	ensure(existsSync(SOURCE_BUNDLE), `missing production demo bundle: ${SOURCE_BUNDLE}; run node examples/dockable-demo/bundle.js first`)
	const original = await readFile(SOURCE_BUNDLE)
	const body = original.toString('utf8')
	const stageRoot = join(outputRoot, 'stage')
	const targetFunctions = TARGET_FUNCTION_CANDIDATES.filter((name) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(body))
	await mkdir(stageRoot, { recursive: true })
	const variants = {}
	for (const [variant, firstLine] of Object.entries({ control: CONTROL, hint: HINT })) {
		const dir = join(stageRoot, variant)
		await mkdir(dir, { recursive: true })
		await cp(SOURCE_HTML, join(dir, 'index.html'))
		await writeFile(join(dir, 'preload.mjs'), stagedPreload())
		const finalBundle = Buffer.from(`${firstLine}\n${body}`)
		await writeFile(join(dir, 'app.bundle.js'), finalBundle)
		const finalText = finalBundle.toString('utf8')
		const functionEventOffsets = Object.fromEntries(targetFunctions.map((name) => {
			const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(finalText)
			ensure(match, `missing staged target function: ${name}`)
			return [name, match.index + match[0].length - 1]
		}))
		variants[variant] = { dir, url: pathToFileURL(join(dir, 'index.html')).href, bundle: join(dir, 'app.bundle.js'), firstLine, bytes: finalBundle.length, sha256: sha256(finalBundle), bodySha256: sha256(body), functionEventOffsets }
	}
	const control = await readFile(variants.control.bundle)
	const hint = await readFile(variants.hint.bundle)
	const controlNl = control.indexOf(10)
	const hintNl = hint.indexOf(10)
	ensure(control.subarray(controlNl + 1).equals(hint.subarray(hintNl + 1)), 'staged bundle bodies differ')
	return { source: { path: SOURCE_BUNDLE, bytes: original.length, sha256: sha256(original) }, variants, invariant: { bodyByteIdentical: true, onlyFirstLineDiffers: true }, targetDiscovery: { candidates: TARGET_FUNCTION_CANDIDATES, targetFunctions, missingCandidates: TARGET_FUNCTION_CANDIDATES.filter((name) => !targetFunctions.includes(name)), source: 'final staged app.bundle.js body; only its preceding first-line comment varies' } }
}

// Node-only preflight: deliberately separate from process spawning so a
// missing import/path failure is caught by a cheap test before Electron runs.
export async function prepareCoordinator(outputRoot) {
	ensure(!existsSync(outputRoot), `output root must not already exist: ${outputRoot}; choose a new DECK_COMPILE_HINT_OUTPUT`)
	await mkdir(outputRoot)
	return { outputRoot, staged: await stageBundles(outputRoot) }
}

async function readEventText(workerDir, workerLog) {
	const files = []
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name)
			if (entry.isDirectory()) visit(file)
			else if (/v8.*\.log$|\.log$/i.test(entry.name) && statSync(file).size < 50 * 1024 * 1024) files.push(file)
		}
	}
	visit(workerDir)
	const texts = await Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8').catch(() => '') })))
	const ownLogs = texts.filter(({ file }) => file !== workerLog)
	return { files: texts.map(({ file }) => file), text: [(await readFile(workerLog, 'utf8').catch(() => '')), ...ownLogs.map(({ text }) => text)].join('\n') }
}

export async function runWorker({ outputRoot, staged, variant, cacheMode, phase, sequence }, spawnProcess = spawn) {
	const id = `${String(sequence).padStart(3, '0')}-${cacheMode}-${phase}-${variant}`
	const workerDir = join(outputRoot, 'workers', id)
	const profileDir = cacheMode === 'cold' ? join(workerDir, 'profile') : join(outputRoot, 'warm-profiles', variant)
	const resultPath = join(workerDir, 'result.json')
	const workerLog = join(workerDir, 'electron.log')
	await mkdir(workerDir, { recursive: true })
	if (cacheMode === 'cold') await rm(profileDir, { recursive: true, force: true })
	const args = [join(REPO, 'bench', 'electron-compile-hint.js'), `--user-data-dir=${profileDir}`, '--no-first-run']
	const child = spawnProcess(ELECTRON, args, {
		cwd: workerDir,
		env: { ...process.env, DECK_COMPILE_HINT_WORKER: '1', DECK_COMPILE_HINT_VARIANT: variant, DECK_COMPILE_HINT_STAGE_URL: staged.variants[variant].url, DECK_COMPILE_HINT_PRELOAD: join(staged.variants[variant].dir, 'preload.mjs'), DECK_COMPILE_HINT_RESULT: resultPath, DECK_COMPILE_HINT_V8_LOG: join(workerDir, 'v8.log'), DECK_COMPILE_HINT_TIMEOUT_MS: String(envNumber('DECK_COMPILE_HINT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 5_000, max: 180_000 })), DECK_COMPILE_HINT_CACHE_MODE: cacheMode, DECK_COMPILE_HINT_PHASE: phase },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	child.stdout.on('data', (chunk) => { output += chunk })
	child.stderr.on('data', (chunk) => { output += chunk })
	const outcome = await new Promise((resolveWorker) => {
		let settled = false
		const finish = (value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.removeListener('error', onError)
			child.removeListener('close', onClose)
			resolveWorker(value)
		}
		const onError = (error) => finish({ exitCode: null, signal: null, error: String(error) })
		const onClose = (exitCode, signal) => finish({ exitCode, signal })
		const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ exitCode: null, signal: 'timeout' }) }, envNumber('DECK_COMPILE_HINT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 5_000, max: 180_000 }) + 5_000)
		child.once('error', onError)
		child.once('close', onClose)
	})
	await writeFile(workerLog, output + (outcome.error ? `\n[spawn error] ${outcome.error}\n` : ''))
	const result = await readFile(resultPath, 'utf8').then(JSON.parse).catch((error) => ({ status: 'missing-result', error: String(error) }))
	const events = await readEventText(workerDir, workerLog)
	const functionEvents = parseFunctionEvents(events.text)
	const functionEventSummary = {
		count: functionEvents.length,
		byKind: Object.fromEntries(functionEvents.reduce((counts, event) => counts.set(event.kind, (counts.get(event.kind) || 0) + 1), new Map())),
		targetEventCounts: Object.fromEntries(staged.targetDiscovery.targetFunctions.map((name) => [name, { total: functionEvents.filter((event) => event.name === name).length, lazyParses: functionEvents.filter((event) => event.name === name && event.kind === 'parse-function').length }])),
	}
	return { id, variant, cacheMode, phase, sequence, profileDir, outcome, result, eventLogFiles: events.files, functionEventSummary, eventText: events.text }
}

async function coordinator() {
	const outputRoot = resolve(process.env.DECK_COMPILE_HINT_OUTPUT || `/tmp/electron-compile-hint-${Date.now()}`)
	const samplesPerVariant = envNumber('DECK_COMPILE_HINT_SAMPLES', DEFAULT_SAMPLES_PER_VARIANT, { min: 2, max: 20 })
	ensure(samplesPerVariant % 2 === 0, 'DECK_COMPILE_HINT_SAMPLES must be even so every ABBA block has equal variants')
	ensure(existsSync(ELECTRON), `Electron executable not found: ${ELECTRON}`)
	const prepared = await prepareCoordinator(outputRoot)
	const staged = prepared.staged
	const report = { schemaVersion: 1, status: 'running', outputRoot, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, method: { source: 'current production dockable-demo browser bundle', scope: 'renderer bundle initialization only: the staged preload stubs the demo bridge, so this is not full native-WebContentsView app startup', transport: 'file://', functionEventFlag: '--log-function_events (diagnostic workers only; prime and timing samples run in trace-free Electron processes)', recognitionRule: 'recognized: a staged-bundle target, matched by script URL/source id/function offset, has parse-function in control and none in hint; unrecognized: it has parse-function in both; no lazy witness: inconclusive', outputRoot: 'must be newly created; existing paths are rejected without deletion so warm profiles are exclusive to this run', cold: 'new Electron profile for every measured worker', warm: 'same per-variant Electron profile is primed once then reused; V8 code-cache hit state is opaque and reported as profile reuse, not proven cache hit', schedule: 'ABBA blocks, with adjacent A/A at block boundaries' }, staged, recognition: null, samples: [], errors: [] }
	const compact = ({ eventText: _eventText, ...sample }) => sample
	const save = () => writeFile(join(outputRoot, 'result.json'), json(report))
	try {
		const diagnosticControl = await runWorker({ outputRoot, staged, variant: 'control', cacheMode: 'cold', phase: 'diagnostic', sequence: 0 })
		const diagnosticHint = await runWorker({ outputRoot, staged, variant: 'hint', cacheMode: 'cold', phase: 'diagnostic', sequence: 1 })
		ensure(diagnosticControl.outcome.exitCode === 0 && diagnosticHint.outcome.exitCode === 0, `diagnostic worker failed: control=${JSON.stringify(diagnosticControl.outcome)} hint=${JSON.stringify(diagnosticHint.outcome)}`)
		const recognitionTargets = Object.fromEntries(['control', 'hint'].map((variant) => [variant, { url: pathToFileURL(staged.variants[variant].bundle).href, offsets: staged.variants[variant].functionEventOffsets }]))
		report.recognition = recognitionFromEvents(diagnosticControl.eventText, diagnosticHint.eventText, staged.targetDiscovery.targetFunctions, recognitionTargets)
		report.samples.push(compact(diagnosticControl), compact(diagnosticHint))
		if (report.recognition.status !== 'recognized') {
			report.status = `no-go-${report.recognition.status}`
			await save()
			console.error(json({ status: report.status, outputRoot, recognition: report.recognition }))
			process.exitCode = 2
			return
		}
		let sequence = 2
		for (const cacheMode of ['cold', 'warm']) {
			if (cacheMode === 'warm') for (const variant of ['control', 'hint']) report.samples.push(compact(await runWorker({ outputRoot, staged, variant, cacheMode, phase: 'prime', sequence: sequence++ })))
			for (let block = 0; block < samplesPerVariant / 2; block++) for (const variant of ['control', 'hint', 'hint', 'control']) report.samples.push(compact(await runWorker({ outputRoot, staged, variant, cacheMode, phase: 'sample', sequence: sequence++ })))
		}
		const bad = report.samples.filter((sample) => sample.outcome.exitCode !== 0 || sample.result.status !== 'pass')
		report.status = bad.length ? 'fail' : 'pass'
		if (bad.length) report.errors.push(...bad.map((sample) => `${sample.id}: ${sample.result.error || JSON.stringify(sample.outcome)}`))
	} catch (error) {
		report.status = 'fail'
		report.errors.push(String(error?.stack || error))
	} finally {
		await save()
	}
	console.log(json({ status: report.status, outputRoot, recognition: report.recognition?.status ?? null, sampleCount: report.samples.length, errors: report.errors.length }))
	process.exitCode = report.status === 'pass' ? 0 : 1
}

async function worker() {
	const resultPath = resolve(process.env.DECK_COMPILE_HINT_RESULT || '/tmp/electron-compile-hint-worker-result.json')
	const timeoutMs = envNumber('DECK_COMPILE_HINT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 5_000, max: 180_000 })
	const report = { schemaVersion: 1, status: 'running', variant: process.env.DECK_COMPILE_HINT_VARIANT, cacheMode: process.env.DECK_COMPILE_HINT_CACHE_MODE, phase: process.env.DECK_COMPILE_HINT_PHASE, url: process.env.DECK_COMPILE_HINT_STAGE_URL, timingsMs: {}, memory: { mainRssBytes: null, rendererRssBytes: null, rendererPid: null }, runtime: { electron: process.versions.electron, chrome: process.versions.chrome, v8: process.versions.v8, node: process.versions.node }, error: null }
	const startedAt = now()
	const mark = (name) => { if (report.timingsMs[name] === undefined) report.timingsMs[name] = now() - startedAt }
	let window = null
	let app = null
	let BrowserWindow
	let ipcMain
	let finished = false
	const finish = async (error = null) => {
		if (finished) return
		finished = true
		if (error) { report.status = 'fail'; report.error = String(error?.stack || error) } else report.status = 'pass'
		try { report.memory.mainRssBytes = process.memoryUsage().rss } catch {}
		try {
			const metrics = app?.getAppMetrics() || []
			const renderer = metrics.find((metric) => metric.pid === report.memory.rendererPid) || metrics.find((metric) => metric.type === 'Tab' || metric.type === 'Renderer')
			if (renderer?.memory?.workingSetSize) report.memory.rendererRssBytes = renderer.memory.workingSetSize * 1024
		} catch {}
		mark('complete')
		await mkdir(dirname(resultPath), { recursive: true })
		await writeFile(resultPath, json(report))
		if (window && !window.isDestroyed()) window.destroy()
		if (app) app.exit(report.status === 'pass' ? 0 : 1)
		else process.exitCode = report.status === 'pass' ? 0 : 1
	}
	try {
		;({ app, BrowserWindow, ipcMain } = await import('electron'))
		ensure(report.variant === 'control' || report.variant === 'hint', 'invalid DECK_COMPILE_HINT_VARIANT')
		ensure(typeof report.url === 'string' && report.url.startsWith('file:'), 'worker requires a file:// stage URL')
		if (report.phase === 'diagnostic') app.commandLine.appendSwitch('js-flags', `--log-function_events --logfile=${process.env.DECK_COMPILE_HINT_V8_LOG}`)
		await app.whenReady(); mark('appReady')
		ipcMain.once('compile-hint:ready', () => mark('rendererReadySignal'))
		window = new BrowserWindow({ show: false, width: 900, height: 520, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: process.env.DECK_COMPILE_HINT_PRELOAD } })
		mark('windowCreated')
		window.webContents.once('dom-ready', () => mark('domReady'))
		window.webContents.once('did-finish-load', () => mark('didFinishLoad'))
		window.webContents.once('render-process-gone', (_event, details) => { void finish(new Error(`renderer process gone: ${JSON.stringify(details)}`)) })
		await window.loadURL(report.url)
		report.memory.rendererPid = window.webContents.getOSProcessId()
		const deadline = now() + timeoutMs
		while (now() < deadline) {
			const interactive = await window.webContents.executeJavaScript('Boolean(window.__deck && document.querySelector("[data-deck-tab]"))', true)
			if (interactive) { mark('interactive'); break }
			await new Promise((resolveWait) => setTimeout(resolveWait, 10))
		}
		ensure(report.timingsMs.interactive !== undefined, `interactive milestone timed out after ${timeoutMs}ms`)
		await finish()
	} catch (error) { await finish(error) }
}

const IS_ENTRY = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (IS_ENTRY && process.env.DECK_COMPILE_HINT_WORKER === '1' && process.versions.electron) void worker()
else if (IS_ENTRY) await coordinator()
