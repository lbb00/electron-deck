import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))
const wrapper = join(repo, 'scripts/check-dockable-e2e.js')
const demoMain = join(repo, 'examples/dockable-demo/main.js')
// The wrapper starts its termination clock the moment it spawns this stub, so
// anything slow here races that clock: a `#!/usr/bin/env node` cold start takes
// ~400ms on a loaded machine, which is most of the shortened timeout the tests
// below use. A shell stub has the pid marker on disk within milliseconds. The
// helper ignores SIGTERM and stays in this process group, so only a SIGKILL
// aimed at the group clears it.
// It deliberately never writes a result file: the wrapper finishes as soon as
// one appears, so a stub that reports success would leave the timeout and
// interrupt paths untested whenever it won that race.
const stubbornElectron = `#!/bin/sh
"$DECK_E2E_NODE" -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)' &
echo $$ > "$DECK_DEMO_SHOTS_DIR/child.pid"
echo '[fixture] ready'
wait
`
// This stub has to stay on Node: the helper needs a process group of its own to
// survive the SIGKILL the wrapper aims at Electron's group, and there is no
// portable shell equivalent of spawn's `detached`. Its caller pays for the cold
// start with a wider timeout instead.
const detachedPipeElectron = `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)'], {
  detached: true,
  stdio: 'inherit',
})
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/child.pid', String(helper.pid))
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-result.json', '{"success":true}')
helper.unref()
process.exit(0)
`

// timeoutMs shortens the wrapper's 60s Electron timeout so a test can reach the
// termination path in seconds. It has to stay above the stub's own startup cost,
// because the clock starts when the stub is spawned, not when it is ready.
async function writeFixture({ pathWithSpaces = false, timeoutMs = 0, electronSource }) {
	const fixture = await mkdtemp(join(tmpdir(), pathWithSpaces ? 'electron deck e2e fixture ' : 'electron-deck-e2e-fixture-'))
	const script = await readFile(wrapper, 'utf8')
	await Promise.all([
		mkdir(join(fixture, 'scripts'), { recursive: true }),
		mkdir(join(fixture, 'examples/dockable-demo'), { recursive: true }),
		mkdir(join(fixture, 'dist'), { recursive: true }),
		mkdir(join(fixture, 'node_modules/.bin'), { recursive: true }),
	])
	await Promise.all([
		writeFile(join(fixture, 'scripts/check-dockable-e2e.js'), timeoutMs ? script.replace('}, 60_000)', `}, ${timeoutMs})`) : script),
		writeFile(join(fixture, 'examples/dockable-demo/main.js'), ''),
		writeFile(join(fixture, 'examples/dockable-demo/app.bundle.js'), ''),
		writeFile(join(fixture, 'dist/index.js'), ''),
		writeFile(join(fixture, 'node_modules/.bin/electron'), electronSource, { mode: 0o755 }),
	])
	return fixture
}

function runNode(script, { cwd, env }) {
	const child = spawn(process.execPath, [script], {
		cwd,
		// Shell stubs start their helpers through this rather than a PATH lookup,
		// which keeps a version-manager shim off the startup path.
		env: { ...process.env, DECK_E2E_NODE: process.execPath, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	})
	let output = ''
	child.stdout.on('data', (chunk) => { output += chunk })
	child.stderr.on('data', (chunk) => { output += chunk })
	return { child, getOutput: () => output }
}

async function closeProcessTree(child) {
	if (child.exitCode !== null) return
	if (process.platform !== 'win32') {
		try { process.kill(-child.pid, 'SIGKILL') } catch {}
	} else {
		child.kill('SIGKILL')
	}
	await once(child, 'close').catch(() => {})
}

async function closeElectronGroup(outputRoot) {
	const entries = await (async () => {
		try { return await readdir(outputRoot, { recursive: true }) } catch { return [] }
	})()
	for (const entry of entries) {
		if (!entry.endsWith('child.pid')) continue
		const pid = Number.parseInt(await readFile(join(outputRoot, entry), 'utf8'), 10)
		if (Number.isSafeInteger(pid) && process.platform !== 'win32') {
			try { process.kill(-pid, 'SIGKILL') } catch {}
		}
	}
}

test('starts Electron when the repository path contains spaces', async () => {
	const fixture = await writeFixture({
		pathWithSpaces: true,
		electronSource: `#!/bin/sh
[ "$1" = "$EXPECTED_MAIN" ] || { echo "unexpected main: $1" >&2; exit 17; }
printf '{"success":true}' > "$DECK_DEMO_SHOTS_DIR/e2e-result.json"
echo '[e2e] result ready'
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output, EXPECTED_MAIN: await realpath(join(fixture, 'examples/dockable-demo/main.js')) },
	})
	try {
		const { code } = await Promise.race([
			once(child, 'close').then(([exitCode]) => ({ code: exitCode })),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper did not exit')), 10_000)),
		])
		assert.equal(code, 0, getOutput())
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('accepts a successful result file without a log readiness marker', async () => {
	const fixture = await writeFixture({
		electronSource: `#!/bin/sh
printf '{"success":true}' > "$DECK_DEMO_SHOTS_DIR/e2e-result.json"
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output },
	})
	try {
		const { code } = await Promise.race([
			once(child, 'close').then(([exitCode]) => ({ code: exitCode })),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper did not exit')), 10_000)),
		])
		assert.equal(code, 0, getOutput())
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('forces wrapper exit when a detached Electron helper holds its output pipes', { skip: process.platform === 'win32' }, async () => {
	const fixture = await writeFixture({ timeoutMs: 3_000, electronSource: detachedPipeElectron })
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output },
	})
	try {
		const { code } = await Promise.race([
			once(child, 'close').then(([exitCode]) => ({ code: exitCode })),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper did not force exit')), 15_000)),
		])
		assert.notEqual(code, 0, getOutput())
		const runs = await readdir(output)
		const log = await readFile(join(output, runs[0], 'electron.log'), 'utf8')
		assert.match(log, /Electron did not close after termination/)
	} finally {
		await closeProcessTree(child)
		await closeElectronGroup(output)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('finishes the hard-exit log when pipe data arrives during shutdown', { skip: process.platform === 'win32' }, async () => {
	const fixture = await writeFixture({
		timeoutMs: 500,
		electronSource: `#!/bin/sh
printf '{"success":true}' > "$DECK_DEMO_SHOTS_DIR/e2e-result.json"
`,
	})
	const wrapperPath = join(fixture, 'scripts/check-dockable-e2e.js')
	let source = await readFile(wrapperPath, 'utf8')
	const streamCreation = "const log = createWriteStream(logPath, { flags: 'a' })"
	const closeListener = "child.once('close', (code, signal) => resolve({ code, signal }))"
	assert.ok(source.includes(streamCreation) && source.includes(closeListener))
source = source.replace(streamCreation, `${streamCreation}
const originalLogWrite = log.write.bind(log)
log.write = (chunk) => {
  if (log.writableEnded) throw new Error('late log write')
  return originalLogWrite(chunk)
}
const originalLogEnd = log.end.bind(log)
log.end = (done) => {
  const result = originalLogEnd(() => setTimeout(done, 200))
  setTimeout(() => child.stdout.emit('data', Buffer.from('late pipe data')), 10)
  return result
}`)
	source = source.replace(closeListener, "child.once('close', () => {})")
	await writeFile(wrapperPath, source)
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(wrapperPath, { cwd: fixture, env: { DECK_E2E_OUTPUT_DIR: output } })
	try {
		const { code } = await Promise.race([
			once(child, 'close').then(([exitCode]) => ({ code: exitCode })),
			new Promise((_, reject) => setTimeout(() => reject(new Error('hard-exit wrapper did not exit')), 10_000)),
		])
		assert.equal(code, 1, getOutput())
		assert.match(getOutput(), /late pipe data/)
		assert.doesNotMatch(getOutput(), /late log write/)
		const runs = await readdir(output)
		const log = await readFile(join(output, runs[0], 'electron.log'), 'utf8')
		assert.match(log, /Electron did not close after termination/)
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('forces a timed-out Electron process group to exit', { skip: process.platform === 'win32' }, async () => {
	const fixture = await writeFixture({
		timeoutMs: 3_000,
		electronSource: stubbornElectron,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output },
	})
	try {
		const { code } = await Promise.race([
			once(child, 'close').then(([exitCode]) => ({ code: exitCode })),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timed-out wrapper did not force exit')), 10_000)),
		])
		assert.notEqual(code, 0, getOutput())
		const runs = await readdir(output)
		const groupId = Number(await readFile(join(output, runs[0], 'child.pid'), 'utf8'))
		assert.throws(() => process.kill(-groupId, 0), { code: 'ESRCH' })
	} finally {
		await closeProcessTree(child)
		await closeElectronGroup(output)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('interrupts and reaps the Electron process group', { skip: process.platform === 'win32' }, async () => {
	const fixture = await writeFixture({ electronSource: stubbornElectron })
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output },
	})
	try {
		await Promise.race([
			once(child.stdout, 'data'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('fixture did not start')), 2_000)),
		])
		child.kill('SIGINT')
		const [{ code }] = await Promise.race([
			once(child, 'close'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('interrupted wrapper did not exit')), 2_000)),
		])
		assert.notEqual(code, 0, getOutput())
		const runs = await readdir(output)
		const groupId = Number(await readFile(join(output, runs[0], 'child.pid'), 'utf8'))
		assert.throws(() => process.kill(-groupId, 0), { code: 'ESRCH' })
	} finally {
		await closeProcessTree(child)
		await closeElectronGroup(output)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('diagnostic E2E mode records process metrics around bounded real drags', async () => {
	const source = await readFile(demoMain, 'utf8')
	assert.match(source, /DECK_DEMO_E2E_METRICS === '1'/)
	assert.match(source, /app\.getAppMetrics\(\)/)
	assert.match(source, /getOSProcessId\(\)/)
	assert.match(source, /workingSetSizeKiB/)
	assert.match(source, /cpuPercent/)
	assert.match(source, /before-drag/)
	assert.match(source, /after-drag/)
	assert.match(source, /repeat-drag-/)
	assert.match(source, /repeatedDragRounds/)
	assert.match(source, /Map\(\)/)
})

test('diagnostic wrapper rejects a missing metrics report', async () => {
	const fixture = await writeFixture({
		electronSource: `#!/bin/sh
printf '{"success":true}' > "$DECK_DEMO_SHOTS_DIR/e2e-result.json"
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output, DECK_DEMO_E2E_METRICS: '1' },
	})
	try {
		const [{ code }] = await once(child, 'close')
		assert.notEqual(code, 0, getOutput())
		assert.match(getOutput(), /metrics report missing or invalid/)
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('diagnostic wrapper rejects metrics errors and incomplete process roles', async () => {
	const fixture = await writeFixture({
		electronSource: `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-result.json', '{"success":true}')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-metrics.json', JSON.stringify({
  errors: [{ label: 'after-drag', message: 'sample failed' }],
  samples: [{ processRoleToPid: [{ role: 'main', pid: 1 }], processes: [{ pid: 1, roles: ['main'], cpuPercent: 0, memory: { workingSetSizeKiB: 1 } }] }],
}))
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output, DECK_DEMO_E2E_METRICS: '1' },
	})
	try {
		const [{ code }] = await once(child, 'close')
		assert.notEqual(code, 0, getOutput())
		assert.match(getOutput(), /metrics report missing or invalid/)
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('diagnostic wrapper rejects a sample without required process metrics', async () => {
	const fixture = await writeFixture({
		electronSource: `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-result.json', '{"success":true}')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-metrics.json', JSON.stringify({
  errors: [],
  samples: [
    ...['before-drag', 'after-drag', 'repeat-drag-0-before', 'repeat-drag-0-after'].map((label) => ({
      label,
      processRoleToPid: [{ role: 'main', pid: 1 }, { role: 'native-preview', pid: 3 }],
      processes: [
        { pid: 1, roles: ['main'], cpuPercent: 0, memory: { workingSetSizeKiB: 1 } },
        { pid: 3, roles: ['native-preview'], cpuPercent: 0, memory: { workingSetSizeKiB: 1 } },
      ],
    })),
  ],
}))
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output, DECK_DEMO_E2E_METRICS: '1' },
	})
	try {
		const [{ code }] = await once(child, 'close')
		assert.notEqual(code, 0, getOutput())
		assert.match(getOutput(), /no valid control-renderer PID/)
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('diagnostic wrapper rejects a process metric without working-set memory', async () => {
	const fixture = await writeFixture({
		electronSource: `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-result.json', '{"success":true}')
writeFileSync(process.env.DECK_DEMO_SHOTS_DIR + '/e2e-metrics.json', JSON.stringify({
  errors: [],
  samples: ['before-drag', 'after-drag', 'repeat-drag-0-before', 'repeat-drag-0-after'].map((label) => ({
    label,
    processRoleToPid: [
      { role: 'main', pid: 1 },
      { role: 'control-renderer', pid: 2 },
      { role: 'native-preview', pid: 3 },
    ],
    processes: [
      { pid: 1, roles: ['main'], cpuPercent: 0, memory: { workingSetSizeKiB: 1 } },
      { pid: 2, roles: ['control-renderer'], cpuPercent: 0, memory: { workingSetSizeKiB: 1 } },
      { pid: 3, roles: ['native-preview'], cpuPercent: 0, memory: {} },
    ],
  })),
}))
`,
	})
	const output = join(fixture, 'output')
	const { child, getOutput } = runNode(join(fixture, 'scripts/check-dockable-e2e.js'), {
		cwd: fixture,
		env: { DECK_E2E_OUTPUT_DIR: output, DECK_DEMO_E2E_METRICS: '1' },
	})
	try {
		const [{ code }] = await once(child, 'close')
		assert.notEqual(code, 0, getOutput())
		assert.match(getOutput(), /missing native-preview working-set metric/)
	} finally {
		await closeProcessTree(child)
		await rm(fixture, { recursive: true, force: true })
	}
})

test('fails when E2E deliberately starts without a main window', { timeout: 20_000 }, async () => {
	const output = await mkdtemp(join(tmpdir(), 'electron-deck-no-main-'))
	const { child, getOutput } = runNode(wrapper, {
		cwd: repo,
		env: { DECK_E2E_OUTPUT_DIR: output, DECK_DEMO_E2E_FORCE_NO_MAIN: '1' },
	})
	try {
		const [{ code }] = await once(child, 'close')
		assert.notEqual(code, 0, getOutput())
		const runs = await readdir(output)
		assert.equal(runs.length, 1, getOutput())
		const report = JSON.parse(await readFile(join(output, runs[0], 'e2e-result.json'), 'utf8'))
		assert.equal(report.success, false)
	} finally {
		await closeProcessTree(child)
		await rm(output, { recursive: true, force: true })
	}
})
