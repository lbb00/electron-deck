/* global clearTimeout, process, setTimeout */
// Electron utility-process half of electron-main-worker-crossover.mjs.
// It deliberately owns only the pure reconcile state: token authorization and
// ViewHandle application stay in the Electron main process.
export function messageFrom(args) {
	for (const value of args) {
		const message = value && typeof value === 'object' && 'data' in value ? value.data : value
		if (message && typeof message === 'object' && typeof message.type === 'string') return message
	}
	return undefined
}

export function waitForExit(child, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} exit timed out after ${timeoutMs}ms`)) }, timeoutMs)
		const done = () => { cleanup(); resolve() }
		const cleanup = () => { clearTimeout(timer); child.removeListener('exit', done) }
		child.once('exit', done)
	})
}

export function createApplyRecorder() {
	const applyByViewId = new Map()
	let count = 0
	return {
		resolveApply(viewId) {
			let apply = applyByViewId.get(viewId)
			if (!apply) {
				apply = () => { count++ }
				applyByViewId.set(viewId, apply)
			}
			return apply
		},
		applyCount: () => count,
	}
}

if (process.parentPort) {
	const layoutEntry = process.env.DECK_CROSSOVER_LAYOUT_ENTRY
	if (!layoutEntry) throw new Error('DECK_CROSSOVER_LAYOUT_ENTRY is required')
	const { createInitialState, reconcile } = await import(layoutEntry)
	let state = createInitialState()
	process.parentPort.on('message', (...args) => {
		const message = messageFrom(args)
		if (!message) return
		if (message.type === 'reset') {
			state = createInitialState()
			process.parentPort.postMessage({ type: 'reset' })
			return
		}
		if (message.type === 'reconcile') {
			const result = reconcile(state, message.snapshot)
			state = result.state
			process.parentPort.postMessage({ type: 'result', id: message.id, state, ops: result.ops })
			return
		}
		if (message.type === 'memory') process.parentPort.postMessage({ type: 'memory', id: message.id, memory: process.memoryUsage() })
	})
}
