/**
 * Reads an Electron/V8 `--trace-opt` + `--trace-deopt` log for one hot-path
 * scenario and decides whether that scenario stayed optimized.
 *
 * A library deopt anywhere in the run fails the scenario. Harness wrappers and
 * Node internals are ignored. Required functions must finish TurboFan at least
 * once; Maglev-only is not enough for those, because the measured steady and
 * moving paths reach TurboFan on Electron's V8.
 */

/** Functions whose deoptimization means the hot path left its stable shape. */
export const LIBRARY_FUNCTIONS = [
	'authorizeSnapshot',
	'reconcile',
	'applyReconciledPlacements',
	'classifyView',
	'emitOps',
	'cleanOneView',
	'roundBounds',
	'sameBounds',
	'sameExtra',
	'sameJsonValue',
	'scanDetached',
	'visibleBounds',
	'setBoundsOp',
	'readSlotToken',
	'isValidBounds',
	'isValidPlacement',
	'isFiniteNumber',
	'flush',
	'set',
]

const HARNESS_FUNCTIONS = new Set(['frames', 'frame', 'drive', 'publisher', 'auth'])

export const SCENARIOS = {
	steady: {
		requiredOptimized: ['classifyView', 'cleanOneView', 'roundBounds'],
	},
	moving: {
		requiredOptimized: ['classifyView', 'cleanOneView', 'roundBounds', 'reconcile'],
	},
	publisher: {
		requiredOptimized: ['set'],
	},
}

const LIBRARY = new Set(LIBRARY_FUNCTIONS)

function functionsIn(line) {
	const found = []
	for (const match of line.matchAll(/JSFunction ([^ <]+) <([^>\s]+)>/g)) {
		found.push({ name: match[1], location: match[2] })
	}
	return found
}

function isLibraryFunction(fn, bundleName) {
	return LIBRARY.has(fn.name)
		&& !HARNESS_FUNCTIONS.has(fn.name)
		&& fn.location.includes(bundleName)
}

/**
 * @param {string} trace Combined stdout and stderr from one scenario process.
 * @param {keyof typeof SCENARIOS} scenario
 * @param {string} [bundleName] Only functions compiled from this workload bundle count.
 */
export function assessTrace(trace, scenario, bundleName = 'workload.js') {
	const spec = SCENARIOS[scenario]
	if (!spec) throw new Error(`unknown V8 JIT scenario: ${scenario}`)

	const deopts = []
	const optimized = new Set()
	for (const line of trace.split('\n')) {
		if (line.includes('deoptimizing')) {
			const fn = functionsIn(line).find((item) => isLibraryFunction(item, bundleName))
			if (fn) deopts.push({ name: fn.name, line: line.trim() })
		}
		if (line.includes('completed optimizing') && line.includes('TURBOFAN')) {
			for (const fn of functionsIn(line)) {
				if (isLibraryFunction(fn, bundleName)) optimized.add(fn.name)
			}
		}
	}

	const missing = spec.requiredOptimized.filter((name) => !optimized.has(name))
	return { ok: deopts.length === 0 && missing.length === 0, deopts, missing, optimized }
}
