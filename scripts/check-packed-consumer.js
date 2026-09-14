import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const outputDir = process.env.DECK_PACKED_CONSUMER_OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'electron-deck-packed-consumer-'))
await mkdir(outputDir, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'electron-deck-packed-consumer-app-'))
const tarball = join(work, 'electron-deck.tgz')
const appDir = join(work, 'app')
const resultPath = join(outputDir, 'packed-consumer-result.json')
const logPath = join(outputDir, 'packed-consumer-electron.log')
const commandTimeoutMs = Number.parseInt(process.env.DECK_PACKED_CONSUMER_TIMEOUT_MS || '120000', 10)

const run = (command, args, options = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
	const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
	let output = ''
	let timedOut = false
	child.stdout.on('data', chunk => { output += chunk })
	child.stderr.on('data', chunk => { output += chunk })
	child.once('error', reject)
	const timer = setTimeout(() => {
		timedOut = true
		output += `\n[packed-consumer] command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}\n`
		try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
	}, timeoutMs)
	child.once('close', (code, signal) => {
		clearTimeout(timer)
		resolve({ code, signal, output, timedOut })
	})
})

let child
try {
	const packed = await run('pnpm', ['pack', '--out', tarball], { cwd: repo, env: process.env })
	if (packed.code !== 0 || packed.timedOut) throw new Error(`pnpm pack failed (${packed.code})\n${packed.output}`)

	await mkdir(appDir, { recursive: true })
	const main = join(appDir, 'consumer-main.mjs')
	await writeFile(join(appDir, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2))
	const offlineInstall = await run('pnpm', ['add', '--offline', tarball, 'electron@43.2.0', '--save-exact'], { cwd: appDir, env: process.env })
	let installed = offlineInstall
	if (offlineInstall.code !== 0) {
		console.warn(`[packed-consumer] offline install unavailable; retrying online: ${offlineInstall.output.trim()}`)
		installed = await run('pnpm', ['add', tarball, 'electron@43.2.0', '--save-exact'], { cwd: appDir, env: process.env })
	}
	if (installed.code !== 0 || installed.timedOut) throw new Error(`consumer install failed after offline/online attempts (${installed.code})\n${installed.output}`)
	await writeFile(main, `
import { app } from 'electron'
import { startElectronDeck } from 'electron-deck'
import { parseLayout, serializeLayout } from 'electron-deck/layout'
import { writeFileSync } from 'node:fs'

const report = { success: false, packageName: 'electron-deck', publicEntry: false, layoutRoundTrip: false, startElectronDeck: false, disposed: false, appQuitRequested: false }
const resultPath = ${JSON.stringify(resultPath)}
const save = () => writeFileSync(resultPath, JSON.stringify(report, null, 2))
void (async () => {
try {
  const tree = { version: 1, root: { kind: 'tabs', id: 'root', panels: ['welcome'], active: 'welcome' } }
  const serialized = serializeLayout(tree)
  report.layoutRoundTrip = serializeLayout(parseLayout(serialized)) === serialized
  report.publicEntry = typeof startElectronDeck === 'function'
  const handle = startElectronDeck({
    app: { window: { width: 320, height: 240, show: false } },
    backend: { async assemble(runtime) { report.startElectronDeck = !!runtime.mainWindow } },
  })
  await handle.ready
  await handle.dispose()
  report.disposed = true
  report.success = report.publicEntry && report.layoutRoundTrip && report.startElectronDeck && report.disposed
  report.appQuitRequested = true
  save()
  app.quit()
} catch (error) {
  report.error = String(error?.stack || error)
  save()
  app.exit(1)
}
})()
`)

	child = spawn(join(appDir, 'node_modules', '.bin', 'electron'), [main], {
		cwd: appDir,
		env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	})
	const chunks = []
	child.stdout.on('data', chunk => chunks.push(chunk))
	child.stderr.on('data', chunk => chunks.push(chunk))
	const timeout = setTimeout(() => {
		try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
	}, 60_000)
	const [code, signal] = await new Promise(resolve => child.once('close', (c, s) => resolve([c, s])))
	clearTimeout(timeout)
	await writeFile(logPath, Buffer.concat(chunks))
	if (code !== 0 || signal !== null) throw new Error(`packed consumer Electron failed (code=${code}, signal=${signal}); log=${logPath}`)
	const report = JSON.parse(await readFile(resultPath, 'utf8'))
	if (!report.success || !report.appQuitRequested) throw new Error(`packed consumer reported failure; log=${logPath}`)
	console.log(JSON.stringify({ success: true, report: resultPath, log: logPath }))
} catch (error) {
	console.error(String(error?.stack || error))
	process.exitCode = 1
} finally {
	if (child && child.exitCode === null) {
		try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
	}
	await rm(work, { recursive: true, force: true })
}
