#!/usr/bin/env node
/**
 * V8 JIT regression for the per-frame hot path.
 *
 * Runs the workload on Electron's own V8 (the main and renderer process), not
 * the system Node binary. Steady bounds, continuously moving bounds, and the
 * placement publisher each get a fresh process. A library function deopt, or a
 * required function that never completes TurboFan, fails the gate.
 *
 * Timing is not gated. Trace flags are passed only to this child process.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { SCENARIOS, assessTrace } from './v8-jit-assess.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const electron = createRequire(import.meta.url)('electron')
const workload = join(root, 'bench', 'v8-jit-workload.js')

function bundleWorkload() {
	const dir = mkdtempSync(join(tmpdir(), 'electron-deck-v8-jit-'))
	const outfile = join(dir, 'workload.js')
	esbuild.buildSync({
		entryPoints: [workload],
		bundle: true,
		minify: false,
		format: 'esm',
		platform: 'node',
		outfile,
	})
	return { dir, outfile }
}

function runScenario(outfile, scenario) {
	const result = spawnSync(electron, [
		'--trace-deopt',
		'--trace-opt',
		'--trace-file-names',
		outfile,
		scenario,
	], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	})
	if (result.error) throw result.error
	const trace = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
	if (result.status !== 0) {
		return {
			ok: false,
			deopts: [],
			missing: [],
			optimized: new Set(),
			spawnError: `workload exited ${result.status}\n${trace.slice(-2000)}`,
		}
	}
	return assessTrace(trace, scenario, 'workload.js')
}

function report(scenario, verdict) {
	if (verdict.spawnError) {
		console.error(`[check-v8-jit] ${scenario} failed to run`)
		console.error(verdict.spawnError)
		return
	}
	if (verdict.ok) {
		const optimized = [...verdict.optimized].sort().join(', ')
		console.log(`[check-v8-jit] ${scenario} OK (TurboFan: ${optimized})`)
		return
	}
	console.error(`[check-v8-jit] ${scenario} FAIL`)
	for (const deopt of verdict.deopts) {
		console.error(`  deopt ${deopt.name}`)
		console.error(`  ${deopt.line}`)
	}
	if (verdict.missing.length > 0) {
		console.error(`  never completed TurboFan: ${verdict.missing.join(', ')}`)
	}
}

function main() {
	const built = bundleWorkload()
	let failed = false
	try {
		for (const scenario of Object.keys(SCENARIOS)) {
			const verdict = runScenario(built.outfile, scenario)
			report(scenario, verdict)
			if (!verdict.ok) failed = true
		}
	}
	finally {
		rmSync(built.dir, { recursive: true, force: true })
	}
	if (failed) {
		console.error('[check-v8-jit] FAIL')
		return 1
	}
	console.log('[check-v8-jit] OK')
	return 0
}

try {
	process.exitCode = main()
}
catch (err) {
	console.error('[check-v8-jit] unexpected failure:', err)
	process.exitCode = 1
}
