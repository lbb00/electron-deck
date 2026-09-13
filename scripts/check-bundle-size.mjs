#!/usr/bin/env node
/**
 * Bundle-size ratchet gate.
 *
 * For every public subpath in package.json's `exports`, bundles a throwaway
 * consumer (`import * as m from '<dist entry>'; console.log(m)`) with esbuild
 * (bundle + minify, matching how a real downstream app would tree-shake this
 * package) and gzips the result. Compares each entry's gzip size against a
 * committed baseline (scripts/bundle-size.baseline.json) and fails (exit 1) if
 * any entry regresses past baseline * RATCHET.
 *
 * `view-anchor` is a runtime dependency but is deliberately NOT marked
 * external: vite.config.ts already inlines it into `dist/client/index.js`
 * (the only importer) at package-build time, so no dist entry ever contains a
 * bare `view-anchor` import specifier for esbuild to resolve here. Everything
 * else a real host provides (electron, react, the peer deps) stays external
 * so we measure only what THIS package adds to a consumer's bundle.
 *
 * Node-only entries build with platform 'node' (esbuild auto-externalizes
 * `node:*` builtins there); the browser-consumed surface (client/layout/
 * dock-react, per check-browser-purity.mjs) builds with platform 'browser'.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const distDir = join(root, 'dist')

const RATCHET = 1.05

const EXTERNAL = ['electron', 'react', 'react-dom', 'react/jsx-runtime', 'react-resizable-panels']

const HELP = `Usage: node scripts/check-bundle-size.mjs [--update] [--baseline <file>]

Bundles a tiny consumer for every public "exports" subpath in package.json
with esbuild (bundle + minify), gzips it, and ratchets each entry against a
per-entry baseline (scripts/bundle-size.baseline.json by default). Any entry
whose gzip size exceeds baseline * ${RATCHET} fails the gate (exit 1).

  --update            Overwrite the baseline file with the sizes just
                       measured. Only run this after a human has reviewed and
                       accepted the size change — this flag is not meant to be
                       run automatically to paper over a red gate.
  --baseline <file>   Read/write a baseline at this path instead of the
                       default (used for self-testing this script).
`

function parseArgs(argv) {
	const args = { update: false, baseline: join(here, 'bundle-size.baseline.json'), help: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--update') args.update = true
		else if (a === '--baseline') args.baseline = resolve(argv[++i])
		else if (a === '--help' || a === '-h') args.help = true
		else {
			console.error(`[check-bundle-size] unknown argument: ${a}`)
			process.exit(2)
		}
	}
	return args
}

/** Node-hosted entries import 'electron' / node builtins for real; the
 * browser-consumed surface (per check-browser-purity.mjs) never does. */
function platformFor(subpath) {
	if (subpath === '.' || subpath === './main' || subpath === './preload' || subpath === './host') return 'node'
	return 'browser'
}

async function measureEntry(subpath, distRelPath, workDir) {
	const absDistPath = join(root, distRelPath)
	if (!existsSync(absDistPath)) {
		throw Object.assign(new Error(`missing dist entry for "${subpath}": ${distRelPath}`), { code: 'MISSING_DIST' })
	}
	const entrySource = `import * as m from ${JSON.stringify(absDistPath)}\nconsole.log(m)\n`
	const entryFile = join(workDir, subpath.replace(/[^a-zA-Z0-9]+/g, '_') + '.entry.mjs')
	writeFileSync(entryFile, entrySource)
	const result = await esbuild.build({
		entryPoints: [entryFile],
		bundle: true,
		minify: true,
		format: 'esm',
		platform: platformFor(subpath),
		external: EXTERNAL,
		write: false,
		logLevel: 'silent',
	})
	const code = result.outputFiles[0].contents
	return gzipSync(code).length
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.help) {
		console.log(HELP)
		process.exit(0)
	}

	if (!existsSync(distDir)) {
		console.error('[check-bundle-size] dist/ not found — run `pnpm run build` first.')
		process.exit(2)
	}

	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
	const exportsMap = pkg.exports
	if (!exportsMap || typeof exportsMap !== 'object') {
		console.error('[check-bundle-size] package.json has no "exports" map.')
		process.exit(2)
	}

	const workDir = mkdtempSync(join(tmpdir(), 'electron-deck-bundle-size-'))
	const current = {}
	try {
		for (const [subpath, entry] of Object.entries(exportsMap)) {
			const distRelPath = typeof entry === 'string' ? entry : entry.default
			current[subpath] = await measureEntry(subpath, distRelPath, workDir)
		}
	}
	finally {
		rmSync(workDir, { recursive: true, force: true })
	}

	if (args.update) {
		mkdirSync(dirname(args.baseline), { recursive: true })
		writeFileSync(args.baseline, JSON.stringify(current, null, '\t') + '\n')
		console.log(`[check-bundle-size] baseline written to ${args.baseline}`)
		printTable(current, current, new Set())
		process.exit(0)
	}

	if (!existsSync(args.baseline)) {
		console.error(`[check-bundle-size] no baseline at ${args.baseline} — run with --update once a human has reviewed the sizes.`)
		process.exit(2)
	}
	const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'))

	const failing = new Set()
	const newEntries = new Set()
	for (const [subpath, size] of Object.entries(current)) {
		const base = baseline[subpath]
		if (base === undefined) {
			newEntries.add(subpath)
			continue
		}
		if (size > base * RATCHET) failing.add(subpath)
	}

	printTable(current, baseline, failing, newEntries)

	if (newEntries.size > 0) {
		console.error(`\n[check-bundle-size] FAIL — new export(s) with no baseline entry: ${[...newEntries].join(', ')} — run with --update after review.`)
	}

	if (failing.size > 0 || newEntries.size > 0) {
		if (failing.size > 0) {
			console.error(`\n[check-bundle-size] FAIL — ${failing.size} entr${failing.size === 1 ? 'y' : 'ies'} exceeded baseline * ${RATCHET}: ${[...failing].join(', ')}`)
		}
		process.exit(1)
	}

	console.log('\n[check-bundle-size] OK — all entries within baseline * ' + RATCHET)
	process.exit(0)
}

function printTable(current, baseline, failing, newEntries = new Set()) {
	const rows = Object.entries(current).map(([subpath, size]) => {
		const base = baseline[subpath]
		const pct = base ? (((size - base) / base) * 100).toFixed(1) + '%' : 'n/a'
		const flag = failing.has(subpath) ? ' FAIL' : newEntries.has(subpath) ? ' NEW' : ''
		return { subpath, base: base ?? size, size, pct, flag }
	})
	const w1 = Math.max(5, ...rows.map((r) => r.subpath.length))
	console.log(`\n${'entry'.padEnd(w1)}  baseline(gz)  current(gz)  change`)
	for (const r of rows) {
		console.log(`${r.subpath.padEnd(w1)}  ${String(r.base).padStart(11)}  ${String(r.size).padStart(11)}  ${r.pct}${r.flag}`)
	}
}

main().catch((err) => {
	if (err && err.code === 'MISSING_DIST') {
		console.error(`[check-bundle-size] ${err.message} — run \`pnpm run build\` first.`)
		process.exit(2)
	}
	console.error('[check-bundle-size] unexpected failure:', err)
	process.exit(1)
})
