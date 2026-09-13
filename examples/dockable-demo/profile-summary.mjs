// Forensic CPU-profile summarizer for the dockable demo. Reads a raw .cpuprofile (as written by
// main.mjs's DECK_DEMO_PROFILE capture) and aggregates SELF time per function
// directly from `samples`/`timeDeltas` — the same signal Chrome DevTools uses
// for its "Self Time" column — rather than walking the call tree.
//
// CPU-profile timing convention (Chrome DevTools protocol): timeDeltas[i] is
// the gap between sample i-1 and sample i (timeDeltas[0] is startTime → first
// sample). The stack captured AT sample i is assumed to run until the NEXT
// sample, so the duration attributed to samples[i] is timeDeltas[i + 1]. The
// final sample has no trailing delta and is dropped (negligible at 100µs
// sampling over multi-second captures).
//
// app.bundle.js is a single-file IIFE (esbuild inlines dist/*, react, react-dom,
// react-resizable-panels, and app.src.jsx together), so every JS callFrame's
// `url` is that ONE file — a url-substring check can't tell "this frame is
// react-dom" from "this frame is our own code". To recover that, this script
// decodes app.bundle.js.map (a standard base64-VLQ source map, no dependency)
// and resolves each callFrame's (lineNumber, columnNumber) back to its ORIGINAL
// source path, then buckets self time by that path.
//
// Usage: node profile-summary.mjs <path-to.cpuprofile>

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TARGET_FUNCTIONS = [
	'layoutsEquivalent',
	'toPercentages',
	'computeFlexiblePercentages',
	'resolveReorderInsertIndex',
]

const CATEGORIES = [
	'src/dock-react',
	'src/layout',
	'src/client',
	'view-anchor',
	'react-dom',
	'react',
	'scheduler',
	'react-resizable-panels',
	'examples/dockable-demo',
	'other',
	'(idle)',
	'(program)',
	'(garbage collector)',
]

function basename(url) {
	if (!url) return '(no url)'
	const clean = url.split('?')[0]
	const parts = clean.split('/')
	return parts[parts.length - 1] || url
}

// ── base64-VLQ source map decoding (Source Map spec v3, no library) ─────────
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Map([...BASE64_CHARS].map((c, i) => [c, i]))

// Decodes one comma-separated mapping token, which may pack several signed
// VLQ numbers back-to-back (each ends when a char's continuation bit is 0).
function decodeVLQNumbers(token) {
	const out = []
	let shift = 0
	let value = 0
	for (const ch of token) {
		const digit = BASE64_LOOKUP.get(ch)
		if (digit === undefined) continue
		const cont = digit & 32
		value += (digit & 31) << shift
		if (cont) {
			shift += 5
		} else {
			const negate = value & 1
			value >>>= 1
			out.push(negate ? -value : value)
			value = 0
			shift = 0
		}
	}
	return out
}

// Returns mappingsByLine[genLine] = [{genColumn, sourceIndex, origLine, origColumn}, ...]
// sorted ascending by genColumn (the encoding already guarantees this per line).
function decodeMappings(mappings) {
	const byLine = []
	let sourceIndex = 0
	let origLine = 0
	let origColumn = 0
	for (const lineStr of mappings.split(';')) {
		const segs = []
		let genColumn = 0
		if (lineStr.length > 0) {
			for (const token of lineStr.split(',')) {
				if (token.length === 0) continue
				const nums = decodeVLQNumbers(token)
				if (nums.length === 0) continue
				genColumn += nums[0]
				if (nums.length >= 4) {
					sourceIndex += nums[1]
					origLine += nums[2]
					origColumn += nums[3]
					segs.push({ genColumn, sourceIndex, origLine, origColumn })
				}
				// segments with only a genColumn (no source fields) carry no mapping;
				// they're skipped since there is nothing to attribute self time to.
			}
		}
		byLine.push(segs)
	}
	return byLine
}

// Binary search: the mapping with the largest genColumn <= column on that line
// (spec: "同一行找不到精确列就取该行中列号不大于目标的最近一条映射").
function lookupOriginal(sourceMap, line, column) {
	if (!sourceMap) return null
	const segs = sourceMap.mappingsByLine[line]
	if (!segs || segs.length === 0) return null
	let lo = 0
	let hi = segs.length - 1
	let ans = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (segs[mid].genColumn <= column) {
			ans = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	if (ans === -1) return null
	const s = segs[ans]
	const source = sourceMap.map.sources[s.sourceIndex]
	if (!source) return null
	return { source, line: s.origLine, column: s.origColumn }
}

const sourceMapCache = new Map()
function loadSourceMapForUrl(url) {
	if (!url) return null
	if (sourceMapCache.has(url)) return sourceMapCache.get(url)
	let filePath
	try {
		filePath = url.startsWith('file://') ? fileURLToPath(url) : url
	} catch {
		sourceMapCache.set(url, null)
		return null
	}
	const mapPath = `${filePath}.map`
	if (!existsSync(mapPath)) {
		sourceMapCache.set(url, null)
		return null
	}
	const map = JSON.parse(readFileSync(mapPath, 'utf8'))
	const result = { map, mappingsByLine: decodeMappings(map.mappings) }
	sourceMapCache.set(url, result)
	return result
}

// ── original-path → category bucket ──────────────────────────────────────
function categorize(functionName, mappedSource) {
	if (functionName === '(idle)') return '(idle)'
	if (functionName === '(program)') return '(program)'
	if (functionName === '(garbage collector)') return '(garbage collector)'
	if (!mappedSource) return 'other'
	const s = mappedSource
	if (s.includes('/react-dom/') || /\breact-dom[.\-]/.test(s)) return 'react-dom'
	if (s.includes('/scheduler/') || /\bscheduler[.\-]/.test(s)) return 'scheduler'
	if (s.includes('react-resizable-panels')) return 'react-resizable-panels'
	if (s.includes('node_modules/react/') || /\breact(\.development|\.production\.min|-jsx-runtime)/.test(s)) return 'react'
	if (s.includes('src/dock-react/')) return 'src/dock-react'
	if (s.includes('src/layout/')) return 'src/layout'
	if (s.includes('src/client/')) return 'src/client'
	if (s.includes('view-anchor')) return 'view-anchor'
	if (s === 'app.src.jsx' || s.includes('examples/dockable-demo')) return 'examples/dockable-demo'
	return 'other'
}

function summarize(path) {
	const profile = JSON.parse(readFileSync(path, 'utf8'))
	const { nodes, samples, timeDeltas } = profile

	const nodeById = new Map()
	for (const n of nodes) nodeById.set(n.id, n)

	const selfUsById = new Map()
	for (let i = 0; i < samples.length; i++) {
		const dur = i + 1 < timeDeltas.length ? timeDeltas[i + 1] : 0
		if (dur <= 0) continue
		const id = samples[i]
		selfUsById.set(id, (selfUsById.get(id) || 0) + dur)
	}

	const totalUs =
		typeof profile.startTime === 'number' && typeof profile.endTime === 'number'
			? profile.endTime - profile.startTime
			: timeDeltas.reduce((a, b) => a + b, 0)
	const totalMs = totalUs / 1000

	const rows = []
	for (const [id, us] of selfUsById) {
		const node = nodeById.get(id)
		if (!node) continue
		const cf = node.callFrame || {}
		const functionName = cf.functionName || '(anonymous)'
		const sourceMap = loadSourceMapForUrl(cf.url)
		const mapped = sourceMap ? lookupOriginal(sourceMap, cf.lineNumber, cf.columnNumber) : null
		rows.push({
			functionName,
			url: cf.url || '',
			file: basename(cf.url),
			lineNumber: cf.lineNumber,
			columnNumber: cf.columnNumber,
			selfMs: us / 1000,
			pct: (us / totalUs) * 100,
			mapped, // {source, line, column} | null — original file this generated frame maps to
			category: categorize(functionName, mapped?.source ?? null),
		})
	}
	rows.sort((a, b) => b.selfMs - a.selfMs)

	// Target functions matched by NAME, cross-checked against the MAPPED source
	// (not url substring) — a row only counts as a real hit if its resolved
	// original path is split-sizing.ts or drag-redock.ts, so a same-named
	// function from an unrelated module (unlikely here, but not assumed) would
	// not be silently folded in.
	const targets = {}
	for (const name of TARGET_FUNCTIONS) {
		const matches = rows.filter((r) => r.functionName === name)
		const confirmed = matches.filter((r) => r.mapped && /split-sizing\.ts|drag-redock\.ts/.test(r.mapped.source))
		const selfMs = matches.reduce((a, r) => a + r.selfMs, 0)
		targets[name] = {
			selfMs,
			pct: (selfMs / totalMs) * 100,
			occurrences: matches.length,
			confirmedByMappedSource: confirmed.length,
			matches: matches.map((r) => ({
				selfMs: r.selfMs,
				mappedSource: r.mapped?.source ?? null,
				mappedLine: r.mapped ? r.mapped.line + 1 : null,
			})),
		}
	}

	const byCategory = {}
	for (const cat of CATEGORIES) byCategory[cat] = { selfMs: 0, occurrences: 0 }
	for (const r of rows) {
		byCategory[r.category].selfMs += r.selfMs
		byCategory[r.category].occurrences += 1
	}
	for (const cat of CATEGORIES) byCategory[cat].pct = (byCategory[cat].selfMs / totalMs) * 100

	return {
		path,
		totalMs,
		sampleCount: samples.length,
		top25: rows.slice(0, 25),
		targets,
		byCategory,
	}
}

function fmt(ms) {
	return ms.toFixed(3)
}

function report(summary) {
	const lines = []
	lines.push(`=== ${summary.path} ===`)
	lines.push(`total sampled duration: ${fmt(summary.totalMs)} ms (${summary.sampleCount} samples)`)
	lines.push('')
	lines.push('top 25 by self time:')
	lines.push('  # | self ms | pct    | function                       | generated file:line | original file:line')
	summary.top25.forEach((r, i) => {
		const orig = r.mapped ? `${r.mapped.source}:${r.mapped.line + 1}` : '(unmapped)'
		lines.push(
			`  ${String(i + 1).padStart(2)} | ${fmt(r.selfMs).padStart(7)} | ${r.pct.toFixed(2).padStart(5)}% | ${r.functionName.padEnd(30).slice(0, 30)} | ${r.file}:${r.lineNumber} | ${orig}`,
		)
	})
	lines.push('')
	lines.push('target functions (matched by name, cross-checked against mapped source path):')
	for (const [name, t] of Object.entries(summary.targets)) {
		lines.push(`  ${name}: ${fmt(t.selfMs)} ms (${t.pct.toFixed(3)}%) — ${t.occurrences} node(s) by name, ${t.confirmedByMappedSource} confirmed via mapped source`)
		for (const m of t.matches) {
			lines.push(`      selfMs=${fmt(m.selfMs)} mappedSource=${m.mappedSource ?? '(unmapped)'} line=${m.mappedLine ?? '-'}`)
		}
	}
	lines.push('')
	lines.push('self time by original-source category:')
	for (const cat of CATEGORIES) {
		const c = summary.byCategory[cat]
		lines.push(`  ${cat.padEnd(24)}: ${fmt(c.selfMs).padStart(9)} ms (${c.pct.toFixed(3).padStart(7)}%) across ${c.occurrences} node(s)`)
	}
	return lines.join('\n')
}

const path = process.argv[2]
if (!path) {
	console.error('usage: node profile-summary.mjs <path-to.cpuprofile>')
	process.exit(1)
}
console.log(report(summarize(path)))
