import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checker = join(root, 'scripts', 'check-tree-shaking.js')

test('fails when a single-symbol layout import retains an unrelated export', () => {
	const distDir = mkdtempSync(join(tmpdir(), 'electron-deck-tree-shaking-test-'))
	try {
		mkdirSync(join(distDir, 'layout'))
		writeFileSync(
			join(distDir, 'layout', 'index.js'),
			`export function createInitialState() { return 'parseLayout: input is not valid JSON' }\n` +
				`export function parseLayout() { return 'parseLayout: input is not valid JSON' }\n`,
		)
		writeFileSync(join(distDir, 'index.js'), `export function defineEvent() { return 'safe' }\n`)

		const result = spawnSync(process.execPath, [checker, '--dist-dir', distDir], {
			cwd: root,
			encoding: 'utf8',
		})
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, /tree-shaking leak: serialize\.ts/)
	}
	finally {
		rmSync(distDir, { recursive: true, force: true })
	}
})

test('fails when a full root import includes dock-react code', () => {
	const distDir = mkdtempSync(join(tmpdir(), 'electron-deck-tree-shaking-test-'))
	try {
		mkdirSync(join(distDir, 'layout'))
		writeFileSync(
			join(distDir, 'layout', 'index.js'),
			`export function createInitialState() { return 'safe' }\n` +
				`export function parseLayout() { return 'parseLayout: input is not valid JSON' }\n`,
		)
		writeFileSync(
			join(distDir, 'index.js'),
			`export function defineEvent() { return 'safe' }\n` +
				`export function dockGeometry() { return 'reorder-only' }\n`,
		)

		const result = spawnSync(process.execPath, [checker, '--dist-dir', distDir], {
			cwd: root,
			encoding: 'utf8',
		})
		assert.equal(result.status, 1, result.stdout + result.stderr)
		assert.match(result.stderr, /root dependency leak: dock-react/)
	}
	finally {
		rmSync(distDir, { recursive: true, force: true })
	}
})

test('removes its temporary work directory when a required dist entry is missing', { skip: process.platform === 'win32' }, () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), 'electron-deck-tree-shaking-test-tmp-'))
	const distDir = mkdtempSync(join(tmpRoot, 'dist-'))
	try {
		mkdirSync(join(distDir, 'layout'))
		writeFileSync(join(distDir, 'layout', 'index.js'), `export function createInitialState() {}\n`)

		const result = spawnSync(process.execPath, [checker, '--dist-dir', distDir], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, TMPDIR: tmpRoot },
		})
		assert.equal(result.status, 2, result.stderr)
		assert.deepEqual(readdirSync(tmpRoot).sort(), [basename(distDir)])
	}
	finally {
		rmSync(tmpRoot, { recursive: true, force: true })
	}
})
