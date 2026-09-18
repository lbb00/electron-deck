import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplyRecorder, messageFrom, waitForExit } from './electron-main-worker-crossover.utility.js'
import { EventEmitter } from 'node:events'

test('utility parent-port message unwraps Electron event.data', () => {
	const payload = { type: 'reset' }
	assert.equal(messageFrom([{ data: payload }]), payload)
})

test('helper close waits for exit and fails on a bounded timeout', async () => {
	const child = new EventEmitter()
	const exited = waitForExit(child, 20, 'synthetic utility')
	child.emit('exit', 0, null)
	await exited
	await assert.rejects(waitForExit(new EventEmitter(), 5, 'stuck utility'), /stuck utility.*timed out/)
})

test('apply recorder starts each measured case with an empty sink cache and count', () => {
	const first = createApplyRecorder()
	first.resolveApply('view-0')({ visible: false })
	assert.equal(first.applyCount(), 1)
	const second = createApplyRecorder()
	assert.equal(second.applyCount(), 0)
	assert.notEqual(second.resolveApply('view-0'), first.resolveApply('view-0'))
})
