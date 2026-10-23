import assert from 'node:assert/strict'
import test from 'node:test'
import { assessTrace } from './v8-jit-assess.js'

const bundle = 'file:///tmp/electron-deck-v8-jit/workload.js'

function optimized(name) {
	return `[completed optimizing 0x1 <JSFunction ${name} <${bundle}> (sfi = 0x2)> (target TURBOFAN_JS)]`
}

function deopt(name, location = bundle) {
	return `[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x1 <JSFunction ${name} <${location}> (sfi = 0x2)>, 0x3 <Code TURBOFAN_JS>, opt id 1, bytecode offset 8, deopt exit 1, FP to SP delta 32, caller SP 0x4, pc 0x5]`
}

test('a steady trace with the required TurboFan functions passes', () => {
	const trace = [
		optimized('classifyView'),
		optimized('cleanOneView'),
		optimized('roundBounds'),
		deopt('frames'),
		deopt('error', 'node:internal/console/constructor'),
	].join('\n')
	const verdict = assessTrace(trace, 'steady')
	assert.equal(verdict.ok, true, JSON.stringify(verdict))
	assert.deepEqual(verdict.deopts, [])
})

test('a library deopt fails even after that function reaches TurboFan', () => {
	const trace = [
		optimized('classifyView'),
		deopt('classifyView'),
		optimized('cleanOneView'),
		optimized('roundBounds'),
	].join('\n')
	const verdict = assessTrace(trace, 'steady')
	assert.equal(verdict.ok, false)
	assert.equal(verdict.deopts.length, 1)
	assert.equal(verdict.deopts[0].name, 'classifyView')
})

test('a moving trace must also optimize reconcile', () => {
	const trace = [
		optimized('classifyView'),
		optimized('cleanOneView'),
		optimized('roundBounds'),
	].join('\n')
	const verdict = assessTrace(trace, 'moving')
	assert.equal(verdict.ok, false)
	assert.deepEqual(verdict.missing, ['reconcile'])
})

test('the publisher gate follows set and ignores a harness deopt', () => {
	const trace = [
		optimized('set'),
		deopt('publisher'),
	].join('\n')
	const verdict = assessTrace(trace, 'publisher')
	assert.equal(verdict.ok, true, JSON.stringify(verdict))
})

test('a builtin named set is not the publisher method', () => {
	const trace = [
		deopt('set', 'native'),
		optimized('set'),
	].join('\n')
	const verdict = assessTrace(trace, 'publisher')
	assert.equal(verdict.ok, true, JSON.stringify(verdict))
	assert.deepEqual(verdict.deopts, [])
})
