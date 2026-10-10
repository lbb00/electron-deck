#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Maintenance documentation and release notes use English. The localized
// README and its language-switch label are the deliberate exceptions.
export function findNonEnglishMaintenance(root) {
	const files = []
	function collect(directory) {
		if (!existsSync(directory)) return
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) collect(path)
			else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
		}
	}
	for (const directory of ['.changeset', 'docs', 'bench']) collect(join(root, directory))
	for (const name of ['README.md', 'CHANGELOG.md']) {
		const path = join(root, name)
		if (existsSync(path)) files.push(path)
	}
	const offenders = []
	for (const path of files) {
		const name = relative(root, path).replaceAll('\\', '/')
		const lines = readFileSync(path, 'utf8').split('\n')
		for (const [index, original] of lines.entries()) {
			const line = name === 'README.md'
				? original.replace('[\u7b80\u4f53\u4e2d\u6587](./README.zh-CN.md)', '')
				: original
			if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(line)) offenders.push(`${name}:${index + 1}`)
		}
	}
	return offenders.sort()
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..')
	const offenders = findNonEnglishMaintenance(root)
	if (offenders.length) {
		console.error('[check-maintainer-language] use English in maintenance documentation and release notes:')
		for (const offender of offenders) console.error(`  ${offender}`)
		process.exitCode = 1
	} else {
		console.log('[check-maintainer-language] OK — maintenance documentation and release notes use English.')
	}
}
