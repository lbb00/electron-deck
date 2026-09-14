#!/usr/bin/env node
/**
 * Consumer-side tree-shaking gate.
 *
 * `sideEffects: false` in package.json only pays off if a bundler actually
 * DROPS the code a consumer never touches. This gate proves it rather than
 * assuming it: for two entries (`./layout`, and the root `.`), it bundles
 * (esbuild, bundle + minify — the same shape a real host's bundler would
 * produce) a "full" consumer that imports the whole namespace against a
 * "single-symbol" consumer that imports exactly one export, then:
 *
 *   1. compares their gzip sizes (informational — reported, not gated), and
 *   2. asserts a source-literal marker unique to the code the single-symbol
 *      consumer should NOT need is absent from that build's output.
 *
 * Markers:
 *  - `./layout`: `createInitialState` (placement-reconcile.ts) never calls
 *    into src/layout/serialize.ts, so parseLayout's distinctive error string
 *    should be shaken out when only createInitialState is imported.
 *  - root `.`: `defineEvent` (events.ts) is a plain declared-event helper
 *    with no dependency on `src/dock-react`; a marker string unique to
 *    dock-react's drag-redock geometry (`'reorder-only'`, a drop-policy
 *    literal) must never reach a main-process-only bundle regardless of
 *    which root symbol is imported.
 *
 * Kept separate from check-bundle-size.js (which measures the STANDARD
 * "import everything" shape for the size ratchet) because this gate asserts
 * string-level absence, a different kind of check with its own failure mode.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as esbuild from 'esbuild'

const root = resolve(import.meta.dirname, '..')

const EXTERNAL = ['electron', 'react', 'react-dom', 'react/jsx-runtime', 'react-resizable-panels']

const SERIALIZE_MARKER = 'parseLayout: input is not valid JSON'
const DOCKREACT_MARKER = 'reorder-only'

const CASES = [
	{
		label: './layout',
		distRelPath: join('layout', 'index.js'),
		platform: 'browser',
		singleImport: '{ createInitialState }',
		singleUse: 'createInitialState',
		marker: SERIALIZE_MARKER,
		markerLabel: 'serialize.ts (parseLayout) marker',
		// createInitialState and parseLayout are siblings re-exported from the
		// same entry, so this is a genuine tree-shaking question.
		requireMarkerInFull: true,
	},
	{
		label: '. (root)',
		distRelPath: 'index.js',
		platform: 'node',
		singleImport: '{ defineEvent }',
		singleUse: 'defineEvent',
		marker: DOCKREACT_MARKER,
		markerLabel: 'dock-react (drag-redock dropPolicy) marker',
		// Unlike ./layout, src/index.ts never imports src/dock-react at all —
		// the FULL root build already lacks this marker. So this case isn't
		// proving tree-shaking; it's a regression guard that nobody wires
		// dock-react into the root entry's dependency graph in the future.
		requireMarkerInFull: false,
	},
]

async function bundle(entrySource, entryFile, platform) {
	writeFileSync(entryFile, entrySource)
	const result = await esbuild.build({
		entryPoints: [entryFile],
		bundle: true,
		minify: true,
		format: 'esm',
		platform,
		external: EXTERNAL,
		write: false,
		logLevel: 'silent',
	})
	// `.text` (decoded string) is what marker substring checks need;
	// `.contents` (Uint8Array) doesn't do substring matching via `.includes()`.
	return result.outputFiles[0].text
}

async function main() {
	const args = process.argv.slice(2)
	if (args.length !== 0 && (args.length !== 2 || args[0] !== '--dist-dir' || !args[1])) {
		console.error('usage: node scripts/check-tree-shaking.js [--dist-dir <path>]')
		process.exit(2)
	}
	const distDir = args.length === 0 ? join(root, 'dist') : resolve(args[1])
	if (!existsSync(distDir)) {
		console.error('[check-tree-shaking] dist/ not found — run `pnpm run build` first.')
		process.exit(2)
	}

	const workDir = mkdtempSync(join(tmpdir(), 'electron-deck-tree-shaking-'))
	let failed = false
	try {
		for (const c of CASES) {
			const distPath = join(distDir, c.distRelPath)
			if (!existsSync(distPath)) {
				console.error(`[check-tree-shaking] missing dist entry: ${distPath} — run \`pnpm run build\` first.`)
				return 2
			}

			const fullSrc = `import * as m from ${JSON.stringify(distPath)}\nconsole.log(m)\n`
			const singleSrc = `import ${c.singleImport} from ${JSON.stringify(distPath)}\nconsole.log(${c.singleUse})\n`

			const fullCode = await bundle(fullSrc, join(workDir, 'full.mjs'), c.platform)
			const singleCode = await bundle(singleSrc, join(workDir, 'single.mjs'), c.platform)

			const fullGz = gzipSync(fullCode).length
			const singleGz = gzipSync(singleCode).length
			const reduction = (((fullGz - singleGz) / fullGz) * 100).toFixed(1)

			console.log(`\n${c.label}`)
			console.log(`  full (import *):        ${fullGz} B gzip`)
			console.log(`  single (${c.singleUse}): ${singleGz} B gzip  (${reduction}% smaller than full)`)

			const fullHasMarker = fullCode.includes(c.marker)
			const singleHasMarker = singleCode.includes(c.marker)

			if (c.requireMarkerInFull && !fullHasMarker) {
				console.error(`  [FAIL] assumption invalid: ${c.markerLabel} ("${c.marker}") was expected in the FULL build but is absent — pick a different marker.`)
				failed = true
				continue
			}
			if (!c.requireMarkerInFull && fullHasMarker) {
				console.error(`  [FAIL] root dependency leak: ${c.markerLabel} ("${c.marker}") reached the FULL root build.`)
				failed = true
				continue
			}
			if (!c.requireMarkerInFull) {
				console.log(`  [note] ${c.markerLabel} is absent even from the FULL build — this entry's source never depends on it; not a tree-shaking result, just architectural separation.`)
			}

			if (singleHasMarker) {
				console.error(`  [FAIL] tree-shaking leak: ${c.markerLabel} ("${c.marker}") survived in the single-symbol (${c.singleUse}) build.`)
				failed = true
			}
			else {
				console.log(`  [OK] ${c.markerLabel} absent from single-symbol build.`)
			}
		}
	}
	finally {
		rmSync(workDir, { recursive: true, force: true })
	}

	if (failed) {
		console.error('\n[check-tree-shaking] FAIL')
		return 1
	}
	console.log('\n[check-tree-shaking] OK')
	return 0
}

main()
	.then((exitCode) => {
		process.exitCode = exitCode
	})
	.catch((err) => {
		console.error('[check-tree-shaking] unexpected failure:', err)
		process.exitCode = 1
	})
