// Real-input Electron check for the dockable demo. Build and bundle are kept
// outside this entry so CI can build once, then invoke this under Xvfb.
import { spawn } from 'node:child_process'
import { existsSync, createWriteStream, watch } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const fromRoot = (path) => new URL(path, root)
const main = fromRoot('examples/dockable-demo/main.js')
const bundle = fromRoot('examples/dockable-demo/app.bundle.js')
const dist = fromRoot('dist/index.js')

for (const artifact of [main, bundle, dist]) {
	if (!existsSync(artifact)) {
		console.error(`[dockable-e2e] missing ${artifact.pathname}; run build and the dockable bundle first`)
		process.exitCode = 1
	}
}
if (process.exitCode) process.exit()

if (process.platform === 'linux' && !process.env.DISPLAY) {
	console.error('[dockable-e2e] DISPLAY is unset; run this check under xvfb-run')
	process.exit(1)
}

const output = process.env.DECK_E2E_OUTPUT_DIR
	? await (async () => {
		await mkdir(process.env.DECK_E2E_OUTPUT_DIR, { recursive: true })
		return mkdtemp(join(process.env.DECK_E2E_OUTPUT_DIR, 'run-'))
	})()
	: await mkdtemp(join(tmpdir(), 'electron-deck-dockable-e2e-'))
const logPath = join(output, 'electron.log')
const resultPath = join(output, 'e2e-result.json')
const metricsPath = join(output, 'e2e-metrics.json')
const metricsEnabled = process.env.DECK_DEMO_E2E_METRICS === '1'
const log = createWriteStream(logPath, { flags: 'a' })
let logClosing = false
const exitAfterLogFlush = (code) => {
	// process.exit() bypasses stream shutdown. Keep an upper bound so a wedged
	// filesystem cannot make the cancellation wrapper hang forever.
	const forceExit = setTimeout(() => process.exit(code), 250)
	logClosing = true
	log.end(() => {
		clearTimeout(forceExit)
		process.exit(code)
	})
}
const electron = process.platform === 'win32'
	? createRequire(import.meta.url)('electron')
	: fileURLToPath(fromRoot('node_modules/.bin/electron'))
const electronArgs = [fileURLToPath(main)]
// Only this test wrapper opts out of Chromium's sandbox on restricted CI hosts.
if (process.env.DECK_E2E_NO_SANDBOX === '1') electronArgs.push('--no-sandbox')
const child = spawn(electron, electronArgs, {
	cwd: fileURLToPath(root),
	env: {
		...process.env,
		DECK_DEMO_E2E: '1',
		DECK_DEMO_SHOTS_DIR: output,
		DECK_DEMO_PRESERVE_OUTPUT: process.env.DECK_E2E_OUTPUT_DIR ? '1' : '0',
	},
	stdio: ['ignore', 'pipe', 'pipe'],
	detached: process.platform !== 'win32',
})

// CI cancellation and local command interruption otherwise only stop this Node
// wrapper, leaving Electron alive with its temporary output directory locked.
let terminationRequested = false
let forceKillTimer
let hardExitTimer
let interruptedSignal
const signalChild = (signal) => {
	if (process.platform !== 'win32') {
		try {
			process.kill(-child.pid, signal)
			return
		} catch (error) {
			if (error.code === 'ESRCH') return
		}
	}
	child.kill(signal)
}
const terminateChild = () => {
	if (terminationRequested) return
	terminationRequested = true
	signalChild('SIGTERM')
	forceKillTimer = setTimeout(() => signalChild('SIGKILL'), 750)
	hardExitTimer = setTimeout(() => {
		signalChild('SIGKILL')
		console.error('[dockable-e2e] Electron did not close after termination')
		log.write('[dockable-e2e] Electron did not close after termination\n')
		exitAfterLogFlush(1)
	}, 3_000)
}
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		if (interruptedSignal) {
			signalChild('SIGKILL')
			return
		}
		interruptedSignal = signal
		terminateChild()
	})
}

let reportReady = false
let outputTail = ''
let passTermination
const maybeReportReady = () => {
	if (reportReady || !existsSync(resultPath)) return
	reportReady = true
	passTermination = setTimeout(terminateChild, 200)
}
const reportWatcher = watch(output, maybeReportReady)
maybeReportReady()
const consumeOutput = (chunk) => {
	outputTail = (outputTail + chunk).slice(-128)
	if (!reportReady && outputTail.includes('[e2e] result ready')) {
		maybeReportReady()
	}
}
child.stdout.on('data', (chunk) => {
	process.stdout.write(chunk)
	if (!logClosing) log.write(chunk)
	consumeOutput(chunk.toString())
})
child.stderr.on('data', (chunk) => {
	process.stderr.write(chunk)
	if (!logClosing) log.write(chunk)
	consumeOutput(chunk.toString())
})

let timedOut = false
const timeout = setTimeout(() => {
	timedOut = true
	console.error('[dockable-e2e] timed out after 60s; terminating Electron')
	log.write('[dockable-e2e] timed out after 60s; terminating Electron\n')
	terminateChild()
}, 60_000)

const result = await new Promise((resolve, reject) => {
	child.once('error', reject)
	child.once('close', (code, signal) => resolve({ code, signal }))
})
clearTimeout(timeout)
clearTimeout(passTermination)
clearTimeout(forceKillTimer)
clearTimeout(hardExitTimer)
reportWatcher.close()
if (terminationRequested) signalChild('SIGKILL')
await new Promise((resolve) => log.end(resolve))

let report
try {
	report = JSON.parse(await readFile(resultPath, 'utf8'))
} catch (error) {
	console.error('[dockable-e2e] result missing or invalid:', error)
}

let metricsError
if (metricsEnabled) {
	try {
		const metrics = JSON.parse(await readFile(metricsPath, 'utf8'))
		if (!Array.isArray(metrics.samples) || metrics.samples.length === 0) {
			throw new Error('no samples')
		}
		if (!Array.isArray(metrics.errors)) {
			throw new Error('errors field is missing')
		}
		if (metrics.errors.length > 0) {
			throw new Error(`${metrics.errors.length} sampling error(s)`)
		}
		const labels = metrics.samples.map((sample) => sample?.label)
		if (!labels.includes('before-drag') || !labels.includes('after-drag')) {
			throw new Error('before-drag/after-drag samples are missing')
		}
		const repeatBefore = labels.filter((label) => typeof label === 'string' && /^repeat-drag-.+-before$/.test(label))
		for (const before of repeatBefore) {
			const after = before.replace(/-before$/, '-after')
			if (!labels.includes(after)) throw new Error(`missing paired sample for ${before}`)
		}
		if (repeatBefore.length === 0) throw new Error('repeated drag samples are missing')
		const requiredRoles = ['main', 'control-renderer', 'native-preview']
		for (const [index, sample] of metrics.samples.entries()) {
			const refs = Array.isArray(sample.processRoleToPid) ? sample.processRoleToPid : []
			const processes = Array.isArray(sample.processes) ? sample.processes : []
			for (const role of requiredRoles) {
				const ref = refs.find((candidate) => candidate?.role === role)
				if (!Number.isSafeInteger(ref?.pid) || ref.pid <= 0) throw new Error(`sample ${index} has no valid ${role} PID`)
				const processMetric = processes.find((candidate) => candidate?.pid === ref.pid && candidate.roles?.includes(role))
				if (!processMetric || typeof processMetric.cpuPercent !== 'number' || !Number.isFinite(processMetric.cpuPercent)) {
					throw new Error(`sample ${index} is missing ${role} CPU metric`)
				}
				if (!processMetric.memory || typeof processMetric.memory.workingSetSizeKiB !== 'number' || !Number.isFinite(processMetric.memory.workingSetSizeKiB)) {
					throw new Error(`sample ${index} is missing ${role} working-set metric`)
				}
			}
		}
	} catch (error) {
		metricsError = error
		console.error('[dockable-e2e] metrics report missing or invalid:', error)
	}
}

console.log(`[dockable-e2e] output: ${output}`)
console.log(`[dockable-e2e] log: ${logPath}`)
if (timedOut || interruptedSignal || report?.success !== true || metricsError || (!terminationRequested && result.code !== 0)) {
	console.error(`[dockable-e2e] failed: exit=${result.code} signal=${result.signal ?? 'none'}`)
	process.exit(1)
}
