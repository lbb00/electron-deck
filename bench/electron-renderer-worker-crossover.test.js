/* global URL */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(resolve(new URL('./electron-renderer-worker-crossover.js', import.meta.url).pathname), 'utf8')

function rendererSection(start, end) {
	const from = source.indexOf(start)
	const to = source.indexOf(end, from)
	assert.ok(from >= 0 && to > from, `could not locate ${start} through ${end}`)
	return source.slice(from, to)
}

test('worker timing and responsiveness windows do not recompute checksums on the renderer main thread', () => {
	assert.match(source, /const precomputeRequests = \(iterations, count, startSeed\)/)
	const series = rendererSection('  const series = async', '  const responsiveness = async')
	const responsiveness = rendererSection('  const responsiveness = async', '  const memory =')
	assert.doesNotMatch(series, /compute\s*\(/)
	assert.doesNotMatch(responsiveness, /compute\s*\(/)
	assert.match(series, /request\.expected/)
	assert.match(responsiveness, /request\.expected/)
})

test('renderer benchmark requires visible-frame progress and reports a worker RSS scope honestly', () => {
	assert.match(source, /window\.showInactive\(\)/)
	assert.match(source, /did not receive requestAnimationFrame within 2000ms/)
	assert.match(source, /let lastFrame = null/)
	assert.match(source, /if \(lastFrame !== null\)/)
	assert.match(source, /interval <= 0/)
	assert.match(source, /workElapsedMs/)
	assert.match(source, /const workEndedAt = now\(\)/)
	assert.match(source, /startTimestampMs: lastFrame, endTimestampMs: timestamp/)
	assert.match(source, /const overlapsWork = interval => interval\.startTimestampMs < workEndedAt/)
	assert.match(source, /allRawRafIntervals/)
	assert.match(source, /workWindowRawRafIntervals/)
	assert.match(source, /documentHidden: document\.hidden, hasFocus: document\.hasFocus\(\)/)
	assert.match(source, /const large = config\.scenarios\.find/)
	assert.match(source, /Fewer than 100 work-window rAF intervals collected/)
	assert.match(source, /afterWorkerStartup/)
	assert.match(source, /no separately attributable RSS/)
})

test('response timer is timestamped and mode-checked against the work window', () => {
	const responsiveness = rendererSection('  const responsiveness = async', '  const memory =')
	assert.match(responsiveness, /const timerProbe = \{ scheduledAt: now\(\), firedAt: null \}/)
	assert.match(responsiveness, /timerProbe\.firedAt = now\(\)/)
	assert.match(responsiveness, /const timerFiredInsideWork = timerProbe\.firedAt >= workStartedAt && timerProbe\.firedAt < workEndedAt/)
	assert.match(responsiveness, /if \(mode === 'worker' && !timerFiredInsideWork\)/)
	assert.match(responsiveness, /if \(mode === 'local' && !timerFiredAfterWork\)/)
	assert.match(responsiveness, /timerProbe,/)
})

test('worker requests have a bounded failure path and termination memory is labelled accurately', () => {
	assert.match(source, /const requestTimeoutMs = 5000/)
	assert.match(source, /setTimeout\(\(\) => settlePending\(id, 'reject'/)
	assert.match(source, /worker\.onerror = event =>/)
	assert.match(source, /worker\.onmessageerror = \(\) =>/)
	assert.match(source, /rejectAllPending\(/)
	assert.match(source, /afterWorkerTerminationRequestedAndRuns/)
})

test('the inline renderer script itself parses, not only the Electron main script', () => {
	const start = source.indexOf('(() => {')
	const end = source.indexOf('</script>`', start)
	assert.ok(start >= 0 && end > start, 'could not locate inline renderer script')
	assert.doesNotThrow(() => new vm.Script(source.slice(start, end)))
})
