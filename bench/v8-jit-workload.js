/**
 * Hot-path workload for scripts/check-v8-jit.js.
 *
 * Bundled without minify so V8 trace lines keep these function names. Bounds
 * are fractional because a real slot rect comes from getBoundingClientRect().
 * One loop per process: calling the driver twice would deopt the harness on a
 * fresh closure and is not a library failure mode.
 */
import { authorizeSnapshot, reconcile, createInitialState, applyReconciledPlacements } from '../src/layout/index.ts'
import { createPlacementPublisher } from '../src/client/placement-publisher.ts'

const mode = process.argv[2]
const FRAMES = 8000
const N = 8
const auth = (token) => ({ viewId: 'v' + token.slice(3), layer: 0 })
const accept = () => () => true

function frame(epoch, jitter) {
	const views = []
	for (let i = 0; i < N; i++) {
		views.push({
			viewId: 'x',
			placement: {
				visible: true,
				bounds: { x: 10.25 * i + jitter, y: 20.5, width: 300.5, height: 200.5 },
			},
			layer: 0,
			extra: { slotToken: 'tok' + i },
		})
	}
	return { generation: 1, epoch, views }
}

function drive(state, epoch, jitter) {
	const clean = authorizeSnapshot(frame(epoch, jitter), auth)
	const result = reconcile(state, clean)
	applyReconciledPlacements(result.ops, result.state, accept)
	return result
}

let sink = 0

if (mode === 'steady' || mode === 'moving') {
	let state = createInitialState()
	for (let i = 0; i < FRAMES; i++) {
		const jitter = mode === 'moving' ? (i % 50) * 0.5 : 0
		const result = drive(state, i + 1, jitter)
		state = result.state
		sink += result.ops.length
	}
}
else if (mode === 'publisher') {
	const queue = []
	const pub = createPlacementPublisher({
		generation: 1,
		publish(snapshot) { sink += snapshot.views.length + snapshot.epoch },
		schedulePublish(cb) { queue.push(cb); return queue.length },
		cancelScheduledPublish() {},
	})
	for (let i = 0; i < FRAMES; i++) {
		const jitter = (i % 50) * 0.5
		for (let v = 0; v < N; v++) {
			pub.set({
				viewId: 'v' + v,
				layer: 0,
				placement: {
					visible: true,
					bounds: { x: 10.25 * v + jitter, y: 20.5, width: 300.5, height: 200.5 },
				},
				extra: { slotToken: 'tok' + v },
			})
		}
		const pending = queue.splice(0, queue.length)
		for (const cb of pending) cb()
	}
}
else {
	throw new Error(`unknown workload mode: ${mode}`)
}

console.error(`sink ${sink}`)
