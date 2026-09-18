import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeLag, createLagReport, median, percentile } from './lag-analysis.js'

test('keeps the existing even-sample median definition', () => {
	assert.equal(median([1, 3]), 2)
})

test('reports DOM interval and DOM-to-native lag tail percentiles', () => {
	const dom = Array.from({ length: 5 }, (_, i) => ({ t: i * 16, w: 100 + i * 10 }))
	const native = Array.from({ length: 5 }, (_, i) => ({ t: i * 16 + 4, width: 100 + i * 10 }))
	const report = analyzeLag(dom, native)
	assert.equal(report.domIntervalSamples, 4)
	assert.equal(report.domIntervalP95, 16)
	assert.equal(report.domIntervalP99, 16)
	assert.equal(report.lagP95, 4)
	assert.equal(report.lagP99, 4)
	assert.equal(report.lagSamples, 4)
	assert.equal(report.lagP99InsufficientSamples, true)
})

test('marks P99 as adequately sampled only at 100 caught-up samples', () => {
	const dom = Array.from({ length: 101 }, (_, i) => ({ t: i * 10, w: 100 + i * 2 }))
	const native = Array.from({ length: 101 }, (_, i) => ({ t: i * 10 + 2, width: 100 + i * 2 }))
	const report = analyzeLag(dom, native)
	assert.equal(report.lagSamples, 100)
	assert.equal(report.lagP99InsufficientSamples, false)
	assert.equal(percentile([1, 2, 3, 4], 99), 4)
})

test('builds a structured lag report with explicit sample sufficiency', () => {
	const lag = analyzeLag(
		[{ t: 0, w: 100 }, { t: 16, w: 120 }],
		[{ t: 4, width: 100 }, { t: 20, width: 120 }],
	)
	const report = createLagReport(lag, { sampleCount: 12, p95Ms: 3.5, p99Ms: 4.2 })
	assert.equal(report.schemaVersion, 1)
	assert.equal(report.lagP99InsufficientSamples, true)
	assert.deepEqual(report.eventLoopDelay, { sampleCount: 12, p95Ms: 3.5, p99Ms: 4.2, p99InsufficientSamples: true })
})
