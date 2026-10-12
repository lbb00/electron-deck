import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findNonEnglishMaintenance } from './check-maintainer-language.js'

function fixture(files, run) {
	const root = mkdtempSync(join(tmpdir(), 'deck-maintainer-language-'))
	try {
		for (const [name, content] of Object.entries(files)) {
			const path = join(root, name)
			mkdirSync(join(path, '..'), { recursive: true })
			writeFileSync(path, content)
		}
		run(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

test('rejects Chinese release notes, archived Changesets, and default documentation', () => {
	fixture({
		'.changeset/fix.md': '---\n"electron-deck": patch\n---\n\n\u4fee\u590d',
		'.changeset/pre/old.md': '\u53d1\u5e03',
		'CHANGELOG.md': '# Changes\n\u4fee\u590d',
		'docs/contracts/example.md': '# Contract\n\u8bf4\u660e',
		'bench/README.md': '\u8bf4\u660e',
	}, (root) => {
		assert.deepEqual(findNonEnglishMaintenance(root), [
			'.changeset/fix.md:5', '.changeset/pre/old.md:1',
			'CHANGELOG.md:2', 'bench/README.md:1', 'docs/contracts/example.md:2',
		])
	})
})

test('allows English maintenance files and the explicit Chinese README localization', () => {
	fixture({
		'.changeset/README.md': 'Write release notes in English.',
		'docs/architecture.md': '# Architecture\nAn English contract.',
		'README.zh-CN.md': '\u4e2d\u6587',
		'README.md': '[English](./README.md) · [\u7b80\u4f53\u4e2d\u6587](./README.zh-CN.md)',
	}, (root) => assert.deepEqual(findNonEnglishMaintenance(root), []))
})

test('rejects Chinese text in the default README even next to the localization link', () => {
	fixture({
		'README.md': '[\u7b80\u4f53\u4e2d\u6587](./README.zh-CN.md)\n\u8bf4\u660e',
	}, (root) => assert.deepEqual(findNonEnglishMaintenance(root), ['README.md:2']))
})
