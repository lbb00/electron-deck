const sortedPercentile = (values, p) => {
	if (!values.length) return null
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
	return sorted[index]
}

export const median = (values) => {
	if (!values.length) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export const percentile = sortedPercentile

export function analyzeLag(domSamples, nativeSamples) {
	const intervals = []
	for (let i = 1; i < domSamples.length; i++) intervals.push(domSamples[i].t - domSamples[i - 1].t)

	let misaligned = 0
	let comparable = 0
	let nIdx = -1
	for (const d of domSamples) {
		while (nIdx + 1 < nativeSamples.length && nativeSamples[nIdx + 1].t <= d.t) nIdx++
		if (nIdx < 0) continue
		comparable++
		if (Math.abs(nativeSamples[nIdx].width - d.w) > 1) misaligned++
	}

	const domChanges = []
	for (let i = 1; i < domSamples.length; i++) {
		if (Math.abs(domSamples[i].w - domSamples[i - 1].w) > 1) {
			domChanges.push({ t: domSamples[i].t, w: domSamples[i].w })
		}
	}

	const lags = []
	let uncaught = 0
	for (let i = 0; i < domChanges.length; i++) {
		const change = domChanges[i]
		const nextChangeT = i + 1 < domChanges.length ? domChanges[i + 1].t : Infinity
		let caughtAt = null
		for (const n of nativeSamples) {
			if (n.t < change.t) continue
			if (Math.abs(n.width - change.w) <= 1) {
				caughtAt = n.t
				break
			}
		}
		if (caughtAt === null || caughtAt >= nextChangeT) uncaught++
		else lags.push(caughtAt - change.t)
	}

	const sampleCount = lags.length
	return {
		frameCount: domSamples.length,
		domIntervalSamples: intervals.length,
		medianInterval: median(intervals),
		domIntervalP95: percentile(intervals, 95),
		domIntervalP99: percentile(intervals, 99),
		misaligned,
		comparable,
		domChangeCount: domChanges.length,
		nativeChangeCount: nativeSamples.length,
		lagMedian: median(lags),
		lagP90: percentile(lags, 90),
		lagP95: percentile(lags, 95),
		lagP99: percentile(lags, 99),
		lagMax: lags.length ? Math.max(...lags) : null,
		lagSamples: sampleCount,
		lagP99InsufficientSamples: sampleCount < 100,
		uncaught,
	}
}

export function createLagReport(lag, eventLoopDelay) {
	const loop = eventLoopDelay ?? { sampleCount: 0, p95Ms: null, p99Ms: null }
	return {
		schemaVersion: 1,
		...lag,
		lagP99InsufficientSamples: lag.lagSamples < 100,
		eventLoopDelay: {
			...loop,
			p99InsufficientSamples: loop.sampleCount < 100,
		},
	}
}
