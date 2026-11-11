#!/usr/bin/env node

/**
 * TLA+ / TLC Model Checking Runner for electron-deck.
 *
 * Automatically manages tla2tools.jar, discovers specifications in specs/,
 * runs TLC model checking, and verifies protocol invariants.
 */

import { spawn, execSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	rmSync,
	readdirSync,
	createWriteStream,
	readFileSync,
} from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { get as httpsGet } from 'node:https'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TLA_VERSION = 'v1.7.4'
const TLA_DOWNLOAD_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar`
const TLA_EXPECTED_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'

const MIN_DISTINCT_STATES = {
	DeckPlacementReconciler: 1000,
	ScopeHierarchy: 1000,
	TrustLeaseGate: 500,
}

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CACHE_DIR = join(REPO_ROOT, '.tla-cache')
const TLA_JAR_PATH = join(CACHE_DIR, 'tla2tools.jar')
const SPECS_DIR = join(REPO_ROOT, 'specs')

function parseArgs() {
	const args = process.argv.slice(2)
	const options = {
		clean: false,
		spec: null,
		workers: 'auto',
	}

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--clean') {
			options.clean = true
		} else if (args[i] === '--spec' && i + 1 < args.length) {
			options.spec = args[++i]
		} else if (args[i] === '--workers' && i + 1 < args.length) {
			options.workers = args[++i]
		}
	}

	return options
}

function checkJava() {
	try {
		const output = execSync('java -version 2>&1', { encoding: 'utf8' })
		const match = output.match(/(?:openjdk|java) version "([^"]+)"/i)
		const version = match ? match[1] : output.split('\n')[0]
		return { ok: true, version }
	} catch (error) {
		return { ok: false, error: error.message }
	}
}

function verifyJarChecksum(filePath) {
	try {
		const fileBuffer = readFileSync(filePath)
		const hash = createHash('sha256').update(fileBuffer).digest('hex')
		return hash === TLA_EXPECTED_SHA256
	} catch {
		return false
	}
}

function downloadFile(targetUrl, destPath, maxRedirects = 5) {
	return new Promise((resolvePromise, rejectPromise) => {
		let finished = false
		let timeoutId = null

		const cleanupAndReject = (err) => {
			if (finished) return
			finished = true
			if (timeoutId) clearTimeout(timeoutId)
			try {
				rmSync(destPath, { force: true })
			} catch {}
			rejectPromise(err)
		}

		if (maxRedirects < 0) {
			cleanupAndReject(new Error('Too many HTTP redirects'))
			return
		}

		const file = createWriteStream(destPath)

		const request = httpsGet(targetUrl, (response) => {
			if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				finished = true
				if (timeoutId) clearTimeout(timeoutId)
				response.resume()
				file.destroy()
				try {
					rmSync(destPath, { force: true })
				} catch {}
				const nextUrl = new URL(response.headers.location, targetUrl).href
				downloadFile(nextUrl, destPath, maxRedirects - 1)
					.then(resolvePromise)
					.catch(rejectPromise)
				return
			}

			if (response.statusCode !== 200) {
				response.resume()
				cleanupAndReject(new Error(`Failed to download: HTTP ${response.statusCode}`))
				return
			}

			response.pipe(file)
			response.on('error', cleanupAndReject)
			file.on('finish', () => {
				if (finished) return
				finished = true
				if (timeoutId) clearTimeout(timeoutId)
				file.close(() => resolvePromise())
			})
			file.on('error', cleanupAndReject)
		})

		timeoutId = setTimeout(() => {
			request.destroy()
			cleanupAndReject(new Error('Download timed out after 30 seconds'))
		}, 30000)

		request.on('error', cleanupAndReject)
	})
}

async function ensureTlaTools() {
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true })
	}

	if (existsSync(TLA_JAR_PATH) && verifyJarChecksum(TLA_JAR_PATH)) {
		return
	}

	process.stdout.write(`Downloading tla2tools.jar (${TLA_VERSION})...\n`)
	await downloadFile(TLA_DOWNLOAD_URL, TLA_JAR_PATH)
	if (!verifyJarChecksum(TLA_JAR_PATH)) {
		rmSync(TLA_JAR_PATH, { force: true })
		throw new Error('Downloaded tla2tools.jar checksum mismatch')
	}
	process.stdout.write(`tla2tools.jar downloaded and verified successfully.\n`)
}

function runTLC(specPath, workers) {
	return new Promise((resolvePromise) => {
		const specName = basename(specPath, '.tla')
		const specMetaDir = join(CACHE_DIR, `metadir-${specName}`)
		mkdirSync(specMetaDir, { recursive: true })

		const tlcArgs = [
			'-cp',
			TLA_JAR_PATH,
			'tlc2.TLC',
			'-deadlock',
			'-nowarning',
			'-cleanup',
			'-metadir',
			specMetaDir,
			'-workers',
			workers,
			specPath,
		]

		const startTime = Date.now()
		const proc = spawn('java', tlcArgs, {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		let stdout = ''
		let stderr = ''

		proc.stdout.on('data', (d) => {
			stdout += d.toString()
		})
		proc.stderr.on('data', (d) => {
			stderr += d.toString()
		})

		proc.on('error', (err) => {
			if (existsSync(specMetaDir)) {
				try {
					rmSync(specMetaDir, { recursive: true, force: true })
				} catch {}
			}
			resolvePromise({
				spec: basename(specPath),
				success: false,
				exitCode: -1,
				elapsed: '0.00',
				statesGenerated: 'N/A',
				distinctStates: 'N/A',
				depth: 'N/A',
				stdout,
				stderr: err.message,
			})
		})

		proc.on('close', (code) => {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

			// Parse TLC output stats
			let statesGenerated = null
			let distinctStates = null
			let depth = null

			const genMatch = stdout.match(/([0-9,]+)\s+states generated/i)
			if (genMatch) statesGenerated = genMatch[1]

			const distMatch = stdout.match(/([0-9,]+)\s+distinct states found/i)
			if (distMatch) distinctStates = distMatch[1]

			const depthMatch = stdout.match(/The depth of the complete state graph search is ([0-9]+)/i)
			if (depthMatch) depth = depthMatch[1]

			const numDistinct = distinctStates ? Number.parseInt(distinctStates.replace(/,/g, ''), 10) : 0
			const minThreshold = MIN_DISTINCT_STATES[specName] ?? 10
			const reachedThreshold = !Number.isNaN(numDistinct) && numDistinct >= minThreshold

			const success =
				code === 0 &&
				reachedThreshold &&
				stdout.includes('Model checking completed. No error has been found.')

			// Clean up spec-isolated metadir
			if (existsSync(specMetaDir)) {
				try {
					rmSync(specMetaDir, { recursive: true, force: true })
				} catch {}
			}

			resolvePromise({
				spec: basename(specPath),
				success,
				exitCode: code,
				elapsed,
				statesGenerated: statesGenerated || 'N/A',
				distinctStates: distinctStates || 'N/A',
				depth: depth || 'N/A',
				stdout,
				stderr,
			})
		})
	})
}

async function main() {
	const options = parseArgs()

	if (options.clean) {
		if (existsSync(CACHE_DIR)) {
			rmSync(CACHE_DIR, { recursive: true, force: true })
			console.log('Cleaned .tla-cache/')
		}
		return
	}

	const javaCheck = checkJava()
	if (!javaCheck.ok) {
		console.error('Error: Java runtime is required to run TLC model checking.')
		console.error(`Details: ${javaCheck.error}`)
		process.exit(1)
	}

	console.log(`Java environment: ${javaCheck.version}`)

	try {
		await ensureTlaTools()
	} catch (err) {
		console.error(`Failed to acquire tla2tools.jar: ${err.message}`)
		process.exit(1)
	}

	if (!existsSync(SPECS_DIR)) {
		console.error(`Specs directory not found at ${SPECS_DIR}`)
		process.exit(1)
	}

	const allSpecs = readdirSync(SPECS_DIR)
		.filter((f) => f.endsWith('.tla') && !f.startsWith('MC_'))
		.sort()

	const specsToRun = options.spec
		? allSpecs.filter((s) => s.toLowerCase().includes(options.spec.toLowerCase()))
		: allSpecs

	if (specsToRun.length === 0) {
		console.error(`No matching specifications found in ${SPECS_DIR}.`)
		process.exit(1)
	}

	console.log(`\nRunning TLA+ Model Checking with TLC (${TLA_VERSION})...\n`)

	const results = []
	let anyFailed = false

	for (const specFile of specsToRun) {
		const fullPath = join(SPECS_DIR, specFile)
		process.stdout.write(`  ⏳ Checking ${specFile.padEnd(28)} `)
		const result = await runTLC(fullPath, options.workers)
		results.push(result)

		if (result.success) {
			process.stdout.write(
				`\x1b[32mPASS\x1b[0m (${result.elapsed}s, ${result.distinctStates} distinct states, depth ${result.depth})\n`,
			)
		} else {
			process.stdout.write(`\x1b[31mFAIL\x1b[0m (exit ${result.exitCode})\n`)
			anyFailed = true
		}
	}

	console.log('\n--- Model Checking Summary ---')
	console.log(
		'Spec'.padEnd(30) +
			'Status'.padEnd(10) +
			'Distinct States'.padEnd(18) +
			'Generated'.padEnd(14) +
			'Time',
	)
	console.log(''.padEnd(77, '-'))
	for (const r of results) {
		const status = r.success ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
		console.log(
			r.spec.padEnd(30) +
				status.padEnd(19) +
				String(r.distinctStates).padEnd(18) +
				String(r.statesGenerated).padEnd(14) +
				`${r.elapsed}s`,
		)
	}

	if (anyFailed) {
		console.log('\nFailure details:\n')
		for (const r of results.filter((res) => !res.success)) {
			console.log(`=== ${r.spec} Output ===\n${r.stdout}\n${r.stderr}\n`)
		}
		process.exit(1)
	} else {
		console.log(
			`\n\x1b[32m✓ All ${results.length} formal specifications verified successfully!\x1b[0m\n`,
		)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
