#!/usr/bin/env node
/**
 * File-extension CI gate. `package.json` sets `"type": "module"` and no nested
 * `package.json` overrides it, so every `.js` file in this repo is already an ES
 * module and `.mjs` buys nothing. This guard exits 1 when a new `.mjs` file
 * appears, so the extension does not creep back in one file at a time.
 *
 * Preload scripts are the one real exception and are allowlisted below:
 * Electron ignores `"type": "module"` when loading a preload and decides the
 * module system from the extension alone, so an ESM preload MUST be `.mjs`.
 * Renaming one to `.js` makes Electron parse it as CommonJS, which fails with
 * `Cannot use import statement outside a module` (see vite.config.preload-cjs.ts).
 *
 * Scans the working tree rather than import specifiers, because oxlint cannot
 * report a file for its own extension and skips `examples/**` entirely — which
 * is exactly where the `.mjs` files used to live.
 * Pure Node fs, no deps. Mirrors the check-browser-purity.js guard pattern.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Directories that hold no authored source, or none we control. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude', 'shots'])

/** Preloads that Electron can only load as ESM when they end in `.mjs`. */
const ALLOWED = new Set([
	'examples/dockable-demo/preload.mjs',
	'examples/layout-demo/demo-preload.mjs',
])

/** Recursively collect every `.mjs` file below `dir`, as repo-relative paths. */
function collect(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...collect(full))
		else if (entry.endsWith('.mjs')) out.push(relative(root, full).split(sep).join('/'))
	}
	return out
}

const found = collect(root)
const offenders = found.filter((file) => !ALLOWED.has(file))
const missing = [...ALLOWED].filter((file) => !found.includes(file))

if (offenders.length > 0) {
	console.error('[check-file-extensions] unexpected .mjs files — rename them to .js:')
	for (const file of offenders) console.error('  ' + file)
	console.error('package.json already sets "type": "module", so .js is an ES module here.')
	console.error('Only Electron preload scripts need .mjs; add one to ALLOWED if you add a preload.')
	process.exit(1)
}

if (missing.length > 0) {
	console.error('[check-file-extensions] allowlisted preload is gone — update ALLOWED in this script:')
	for (const file of missing) console.error('  ' + file)
	process.exit(1)
}

console.log(`[check-file-extensions] OK — no stray .mjs; ${ALLOWED.size} allowlisted preloads present.`)
process.exit(0)
