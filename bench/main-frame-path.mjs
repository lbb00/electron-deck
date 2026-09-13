#!/usr/bin/env node
/* global URL, console, process */
/**
 * Main-process per-frame path benchmark: cleanSnapshot -> reconcile ->
 * dispatchOps, the loop that runs once per renderer-reported frame while a
 * dock layout is live. Two scenarios:
 *   - steady:  bounds unchanged frame-to-frame (the common case — most
 *              frames should produce zero ops).
 *   - moving:  every view's bounds shift by 1px/frame (worst case — every
 *              frame produces ops for every view).
 *
 * Requires --expose-gc: the benchmark reports both heap growth before the
 * final GC (allocation pressure) and after it (retained heap). See
 * bench/README.md for how to read the numbers and how to diff against another
 * branch's dist.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (typeof globalThis.gc !== 'function') {
	console.error('bench/main-frame-path.mjs requires --expose-gc (heap deltas are meaningless without a forced GC baseline).')
	console.error('Usage: node --expose-gc bench/main-frame-path.mjs')
	console.error('       DIST=<path-to-dist>/layout node --expose-gc bench/main-frame-path.mjs   # bench another branch\'s build')
	process.exit(2)
}

// Default: this repo's own dist/layout/index.js. DIST overrides with the
// path to a *different* dist/layout directory (e.g. a git-worktree build of
// another branch), for before/after comparison — see bench/README.md.
const layoutEntry = process.env.DIST
	? pathToFileURL(join(process.env.DIST, 'index.js')).href
	: new URL('../dist/layout/index.js', import.meta.url).href

const { cleanSnapshot, reconcile, createInitialState, dispatchOps } = await import(layoutEntry)

const N = 8
const FRAMES = 200000
const auth = (t) => ({ viewId: 'v' + t.slice(3), layer: 0 })

function frame(epoch, jitter) {
	const views = []
	for (let i = 0; i < N; i++) {
		views.push({ viewId: 'x', placement: { visible: true, bounds: { x: 10 * i + jitter, y: 20, width: 300, height: 200 } }, layer: 0, extra: { slotToken: 'tok' + i } })
	}
	return { generation: 1, epoch, views }
}

let state = createInitialState()
let EP = 0
const apply = () => () => {}

// warmup + attach
for (let e = 0; e < 2000; e++) {
	const c = cleanSnapshot(frame(EP++, 0), auth)
	const r = reconcile(state, c)
	state = r.state
	dispatchOps(r.ops, state, apply)
}

function run(label, jitterFn) {
	globalThis.gc()
	const h0 = process.memoryUsage().heapUsed
	const t0 = process.hrtime.bigint()
	let ops = 0
	for (let e = 0; e < FRAMES; e++) {
		const c = cleanSnapshot(frame(EP++, jitterFn(e)), auth)
		const r = reconcile(state, c)
		state = r.state
		ops += r.ops.length
		dispatchOps(r.ops, state, apply)
	}
	const ns = Number(process.hrtime.bigint() - t0) / FRAMES
	const hPreGC = process.memoryUsage().heapUsed
	globalThis.gc()
	const hRetained = process.memoryUsage().heapUsed
	console.log(`${label}: ${(ns / 1000).toFixed(2)} µs/frame (${(ns / 1000 / N).toFixed(2)} µs/view), ops/frame=${(ops / FRAMES).toFixed(2)}, heap growth ${((hPreGC - h0) / 1048576).toFixed(1)} MB before final GC, ${((hRetained - h0) / 1048576).toFixed(1)} MB retained after final GC`)
}

run('steady (bounds unchanged)', () => 0)
run('moving (1px/frame, all views)', (e) => e % 50)

// Synthetic input construction for context; JIT optimization can differ from
// the end-to-end path, so this is not a lower bound for IPC deserialization.
{
	const t0 = process.hrtime.bigint()
	let k = 0
	for (let e = 0; e < FRAMES; e++) k += frame(e, 0).views.length
	console.log(`synthetic input construction: ${(Number(process.hrtime.bigint() - t0) / FRAMES / 1000).toFixed(2)} µs/frame (${k} views built)`)
}
