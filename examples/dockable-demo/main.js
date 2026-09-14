// electron-deck DOCKABLE demo — host (offscreen, self-verifying).
//
// This is the P-1 fallback deliverable: a standalone Electron example proving
// the NEW React `<DockView>` dock-shell adapter drives a real docking UI with a
// native WebContentsView FOLLOWING a DOM slot, plus serialize/restore.
//
// Host wiring mirrors layout-demo/main.js (startElectronDeck, offscreen
// showInactive at -3000, native block via runtime.view().placeIn, composite
// screenshots, captureRetry). The KEY DIFFERENCE: the renderer DOM is driven by
// React <DockView> (not hand-rolled DOM), and the native simulator block is
// anchored to the dock's native slot selector [data-deck-native-slot="simulator"].
//
// Run offscreen:  electron examples/dockable-demo/main.js
//
// Proves (with explicit ✅/❌ trace lines):
//   1. DOM tab switch — clicking [data-deck-tab="logs"] flips g-right active to
//      'logs' in the model, shows the logs body, and leaves the editor body
//      mounted-but-hidden (DockView keeps inactive panel DOM around to
//      preserve React state/scroll — see panel-body.tsx).
//   2. Native slot following — resizing the dock host (renderer-driven) moves
//      the native simulator WebContentsView to track its slot rect.
//   3. Serialize/restore — serialize (after tab switch + movePanel), teardown,
//      parseLayout + validateTree, rebuild a fresh model+DockView, assert the
//      restored DOM reflects the persisted tree.

import { app, ipcMain } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import { startElectronDeck } from '../../dist/index.js'
import { analyzeLag, createLagReport } from './lag-analysis.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// E2E runs supply an isolated output directory so they never truncate a
// developer's hand-captured screenshots or trace. The normal demo keeps its
// historical in-tree shots/ location.
const SHOTS = process.env.DECK_DEMO_SHOTS_DIR
	? resolve(process.env.DECK_DEMO_SHOTS_DIR)
	: join(HERE, 'shots')
const E2E = process.env.DECK_DEMO_E2E === '1'
// Explicit opt-in: normal E2E keeps the existing duration and interaction set.
const E2E_METRICS = E2E && process.env.DECK_DEMO_E2E_METRICS === '1'
const E2E_RECOVERY = E2E ? process.env.DECK_DEMO_E2E_RECOVERY : ''
const PRESERVE_E2E_OUTPUT = E2E && process.env.DECK_DEMO_PRESERVE_OUTPUT === '1'
const BLOCK = pathToFileURL(join(HERE, '..', 'layout-demo', 'block.html')).href
const INDEX = pathToFileURL(join(HERE, 'index.html')).href
const PRELOAD = join(HERE, 'preload.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Cold-start baseline: computed once, as early as possible, from the process's
// own start time (process.uptime() is relative to actual process start, not to
// this module's eval time) — every [startup] timestamp below is "+Xms since
// process start" using this same reference.
const T0 = Date.now() - process.uptime() * 1000
const since = () => Math.round(Date.now() - T0)

// Unbuffered trace (survives a hang — main stdout is block-buffered when piped),
// truncated at the top of each run so trace.log only ever holds THIS run.
const TRACE = join(SHOTS, 'trace.log')
mkdirSync(SHOTS, { recursive: true })
if (!PRESERVE_E2E_OUTPUT) writeFileSync(TRACE, '')
let failed = false
let recoveryStatus = E2E_RECOVERY ? 'running' : null
const log = (...a) => {
	const line =
		'[demo] ' +
		a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
	console.log(line)
	if (line.includes('❌')) failed = true
	try {
		appendFileSync(TRACE, line + '\n')
	} catch {}
}

if (E2E) log('[e2e] isolated output:', SHOTS)

// ── cold-start timestamps (unconditional, zero-cost, no ✅/❌) ────────────────
// Four points on the boot timeline, all measured against T0 (process start):
// app.whenReady() settling, the main BrowserWindow's creation, the renderer's
// demo:ready (React mounted + client live), and the native simulator view's
// first non-zero-size bounds. Emitted as ONE combined line once all four land.
const startupTimes = { ready: null, window: null, mounted: null, firstPlacement: null }
let startupLogged = false
function maybeEmitStartupLine() {
	if (startupLogged) return
	const { ready, window, mounted, firstPlacement } = startupTimes
	if (ready === null || window === null || mounted === null || firstPlacement === null) return
	startupLogged = true
	log(`[startup] ready=+${ready}ms window=+${window}ms mounted=+${mounted}ms firstPlacement=+${firstPlacement}ms`)
}
app.on('browser-window-created', () => {
	if (startupTimes.window === null) startupTimes.window = since()
	maybeEmitStartupLine()
})
app.whenReady().then(() => {
	if (startupTimes.ready === null) startupTimes.ready = since()
	maybeEmitStartupLine()
})

// ── composite-screenshot machinery (host page + native block in z-order) ──────
let compositeReq = 0
const compositeWaiters = new Map()
ipcMain.on('demo:composite-result', (_e, reqId, dataUrl) => {
	const res = compositeWaiters.get(reqId)
	if (res) {
		compositeWaiters.delete(reqId)
		res(dataUrl)
	}
})

const placedBlocks = [] // { handle, label, zone }
let rejectedOpenProjects = 0

// Electron reports ProcessMetric.memory sizes in KiB. Its CPU percentage is an
// average over the interval since the previous getAppMetrics() call; the first
// call establishes the baseline. Multiple WebContents can share one renderer
// PID, so the report groups roles by PID while retaining the role-to-PID mapping.
const metricsReport = {
	schemaVersion: 1,
	enabled: E2E_METRICS,
	memoryUnit: 'KiB',
	cpuUnit: 'percentCPUUsage',
	cpuInterpretation: 'ProcessMetric.cpu.percentCPUUsage is an average over the interval since the previous getAppMetrics() call; the first sample establishes the baseline; do not infer a leak from one run',
	repeatedDragRounds: 6,
	samples: [],
	errors: [],
}

async function captureE2EMetrics(mainWin, label) {
	if (!E2E_METRICS) return
	try {
		const refs = [
			{ role: 'main', pid: process.pid },
			{ role: 'control-renderer', pid: mainWin.webContents.getOSProcessId() },
		]
		for (const block of placedBlocks) {
			if (block.label !== 'SIMULATOR' || block.handle.webContents.isDestroyed()) continue
			refs.push({ role: 'native-simulator', pid: block.handle.webContents.getOSProcessId() })
		}
		const byPid = new Map()
		for (const ref of refs) {
			if (!Number.isSafeInteger(ref.pid) || ref.pid <= 0) continue
			const existing = byPid.get(ref.pid)
			if (existing) existing.roles.push(ref.role)
			else byPid.set(ref.pid, { pid: ref.pid, roles: [ref.role] })
		}
		const appMetrics = await app.getAppMetrics()
		const metricByPid = new Map(appMetrics.map((metric) => [metric.pid, metric]))
		const processes = [...byPid.values()].map((ref) => {
			const metric = metricByPid.get(ref.pid)
			return {
				pid: ref.pid,
				roles: ref.roles,
				type: metric?.type ?? null,
				creationTime: metric?.creationTime ?? null,
				cpuPercent: metric?.cpu?.percentCPUUsage ?? null,
				memory: metric?.memory
					? {
						workingSetSizeKiB: metric.memory.workingSetSize ?? null,
						peakWorkingSetSizeKiB: metric.memory.peakWorkingSetSize ?? null,
						privateBytesKiB: metric.memory.privateBytes ?? null,
					}
					: null,
			}
		})
		metricsReport.samples.push({ label, atMs: since(), processRoleToPid: refs, processes })
	} catch (error) {
		metricsReport.errors.push({ label, message: String(error) })
		log('[metrics] sample failed:', label, String(error))
	}
}

// 5ms poll for the native simulator view's first non-zero-size bounds — the
// last of the four [startup] cold-start points (see maybeEmitStartupLine).
const firstPlacementPoll = setInterval(() => {
	if (startupTimes.firstPlacement !== null) {
		clearInterval(firstPlacementPoll)
		return
	}
	for (const blk of placedBlocks) {
		if (blk.label !== 'SIMULATOR' || blk.handle.webContents.isDestroyed()) continue
		const b = blk.handle.bounds()
		if (b && b.width > 0 && b.height > 0) {
			startupTimes.firstPlacement = since()
			maybeEmitStartupLine()
			clearInterval(firstPlacementPoll)
			break
		}
	}
}, 5)

// Offscreen capturePage() of native WebContentsViews is finicky (UnknownVizError
// right after a layout change). Retry with a short settle — harness concern.
async function captureRetry(capturer, label, tries = 5) {
	let lastErr
	for (let i = 0; i < tries; i++) {
		try {
			return await capturer()
		} catch (e) {
			lastErr = e
			await sleep(300)
		}
	}
	log(`capture failed after ${tries} tries (${label}): ${String(lastErr)}`)
	throw lastErr
}

async function shot(win, name) {
	try {
		const hostImg = await captureRetry(() => win.webContents.capturePage(), 'host')
		const ordered = [...placedBlocks].sort((a, b) => a.zone - b.zone)
		const blocks = []
		for (const blk of ordered) {
			if (blk.handle.webContents.isDestroyed()) continue
			const b = blk.handle.bounds()
			if (!b || b.width === 0 || b.height === 0) continue
			const png = (await captureRetry(() => blk.handle.capturePage(), blk.label)).toDataURL()
			blocks.push({ png, x: b.x, y: b.y, width: b.width, height: b.height, label: blk.label })
		}
		const reqId = ++compositeReq
		const done = new Promise((res) => compositeWaiters.set(reqId, res))
		win.webContents.send('demo:composite', reqId, hostImg.toDataURL(), blocks)
		const dataUrl = await done
		const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
		await writeFile(join(SHOTS, name), buf)
		log('shot →', name, `(${blocks.length} native blocks)`)
	} catch (e) {
		// Screenshots are NICE-TO-HAVE; bounds deltas are the authoritative proof.
		log('shot skipped (capture flaky):', name, String(e))
	}
}

log('boot: about to call startElectronDeck()')

let resolveDone
let quitting = false
const allDone = new Promise((r) => {
	resolveDone = r
})

// Renderer signals readiness (React mounted + client live) via demo:ready.
let resolveReady
let readyWaiter = null
const rendererReady = new Promise((r) => {
	resolveReady = r
})
ipcMain.on('demo:ready', () => {
	startupTimes.mounted = since()
	maybeEmitStartupLine()
	log('renderer: demo:ready received')
	resolveReady()
	resolveReady = () => {}
	if (readyWaiter) {
		const waiter = readyWaiter
		readyWaiter = null
		waiter()
	}
})

function waitForRendererReady(label) {
	return new Promise((resolve) => {
		if (readyWaiter) throw new Error(`renderer readiness waiter already active (${label})`)
		readyWaiter = resolve
	})
}

const { ready } = startElectronDeck({
	app: {
		window: { width: 900, height: 520, show: false, backgroundColor: '#1e1e2e' },
		source: { url: INDEX },
	},
	backend: {
		mainWindowWebPreferences() {
			return {
				preload: PRELOAD,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			}
		},

		async assemble(runtime) {
			log('assemble: entered')
			const main = E2E && process.env.DECK_DEMO_E2E_FORCE_NO_MAIN === '1'
				? null
				: runtime.windows.main
			if (!main) {
				failed = true
				log('❌ assemble: runtime.windows.main is null — aborting')
				resolveDone()
				return
			}
			const mainWin = main.window

			mainWin.webContents.on('preload-error', (_e, path, err) => {
				log('[preload-error]', path, String(err))
			})
			mainWin.webContents.on('console-message', (_e, _lvl, message) => {
				if (/error|deck|slot|✅|❌/i.test(message)) log('[renderer-console]', message)
			})

			// ── open-project handler: REGISTER EARLY (before the load-wait). The
			// renderer's bindNativeSlot fires demo:open-project automatically on the
			// FIRST native-slot mount, which races the page load — registering the
			// handler here (not after the await) means that early send is never
			// dropped. Places ONE native block anchored to the DOCK's native slot
			// selector. The renderer's createDeckLayoutClient measures that selector
			// and threads placements back — the framework moves the WCV. We write NO
			// resize code; geometry is 100% renderer (DockView) driven.
			let session = null
			let recoveryMove = Promise.resolve()
			ipcMain.on('demo:open-project', (event, projectId) => {
				const senderFrame = event.senderFrame
				if (
					event.sender !== mainWin.webContents
					|| senderFrame !== mainWin.webContents.mainFrame
					|| senderFrame?.url !== INDEX
				) {
					rejectedOpenProjects++
					log('⚠️ open-project rejected: untrusted sender/frame/url', JSON.stringify({
						sameSender: event.sender === mainWin.webContents,
						sameMainFrame: senderFrame === mainWin.webContents.mainFrame,
						url: senderFrame?.url ?? null,
					}))
					return
				}
				if (placedBlocks.length) {
					const block = placedBlocks.find((candidate) => candidate.label === 'SIMULATOR')
					if (!block) {
						failed = true
						log('❌ open-project recovery: SIMULATOR handle is missing')
						return
					}
					recoveryMove = recoveryMove.then(async () => {
						log('open-project recovery:', projectId)
						await block.handle.moveTo(mainWin, { zone: 0, anchor: '[data-deck-native-slot="simulator"]' })
						log('open-project recovery: SIMULATOR re-anchored')
					}).catch((error) => {
						failed = true
						log('❌ open-project recovery failed:', String(error))
					})
					return
				}
				log('open-project:', projectId)
				session = main.newSession()
				const handle = runtime
					.view({ source: { url: `${BLOCK}#${enc('#c0392b', 'SIMULATOR')}` }, scope: session })
					.placeIn(mainWin, { zone: 0, anchor: '[data-deck-native-slot="simulator"]' })
				placedBlocks.push({ handle, label: 'SIMULATOR', zone: 0 })
				log('placed native SIMULATOR view; placedBlocks =', String(placedBlocks.length))
			})

			main.onClose(async () => {
				if (quitting) return 'close'
				if (session) {
					await session.reset()
					session = null
					return 'keep'
				}
				return 'close'
			})

			// Wait for the framework-driven source load to settle (so child WCVs
			// composite into capturePage after showInactive).
			if (mainWin.webContents.isLoading()) {
				log('assemble: awaiting source load')
				await new Promise((res) => {
					const done = (tag) => (...a) => {
						mainWin.webContents.off('did-finish-load', finish)
						mainWin.webContents.off('did-fail-load', fail)
						res()
						if (tag === 'fail') log('[did-fail-load]', ...a.slice(1).map(String))
					}
					const finish = done('finish')
					const fail = done('fail')
					mainWin.webContents.once('did-finish-load', finish)
					mainWin.webContents.once('did-fail-load', fail)
				})
				log('assemble: source load settled')
			}

			// The regular demo remains out of the way. Chromium only honours
			// sendInputEvent mouse gestures for a focused BrowserWindow, so E2E makes
			// the window visible (under Xvfb in CI) and explicitly focuses it.
			if (E2E) {
				mainWin.setPosition(0, 0)
				mainWin.show()
				app.focus({ steal: true })
				mainWin.focus()
				mainWin.webContents.focus()
				await sleep(150)
				log('[e2e] window shown and focus requested')
			} else {
				mainWin.setPosition(-3000, -3000)
				mainWin.showInactive()
			}

			const verification = E2E_RECOVERY
				? runE2ERecoveryVerification(mainWin)
				: E2E ? runE2EVerification(mainWin) : runVerification(mainWin)
			void Promise.race([
				verification,
				new Promise((_, reject) => setTimeout(() => reject(new Error('verification timed out after 45s')), 45_000)),
			]).then((result) => {
				log('[verification] resolved')
				resolveDone(result)
			}).catch((err) => {
				failed = true
				log('❌ verification failed: ' + (err && err.stack ? err.stack : String(err)))
				resolveDone()
			})
		},
	},
})

ready.catch((err) => {
	failed = true
	log('❌ startElectronDeck failed: ' + String(err))
	app.exit(1)
})

function enc(color, label) {
	return encodeURIComponent(`${color}|${label}`)
}

function simBounds() {
	for (const blk of placedBlocks) {
		if (blk.label !== 'SIMULATOR') continue
		if (blk.handle.webContents.isDestroyed()) return null
		const b = blk.handle.bounds()
		return b ? { x: b.x, width: b.width } : null
	}
	return null
}

// ── shared pointer-drag driver (real sendInputEvent drag on the split resize
// handle) — used by both the CPU-profile capture (scenario B) and the
// DECK_DEMO_LAG lag measurement, so the actual drag mechanics live in exactly
// one place. Returns null if no resize-handle element is found (nothing was
// dragged); otherwise drives mouseDown → `rounds` × (5×+4px, 5×-4px) →
// mouseUp and returns the handle's center point. `onPeak` (optional) fires
// once, right after round 0's forward half (i.e. at +20px peak displacement)
// — the CPU-profile capture uses it to sample simBounds() at a known
// mid-drag point; the lag measurement doesn't need it.
async function driveSplitDrag(mainWin, { rounds = 40, onPeak, returnToStart = true } = {}) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)
	// `data-deck-resize-handle` is this codebase's actual Separator attribute
	// (src/dock-react/split-view.tsx) — checked first; the other two are kept as
	// fallbacks in case a future dock renders a bare rrp handle.
	const handleRect = await js(`
		(() => {
			const el = document.querySelector('[data-deck-resize-handle]')
				|| document.querySelector('[data-panel-resize-handle-id]')
				|| document.querySelector('[data-resize-handle]')
			if (!el) return null
			const r = el.getBoundingClientRect()
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
		})()
	`)
	if (!handleRect) return null
	// `modifiers: ['leftbuttondown']` on the mouseMove events is required: Electron's
	// MouseInputEvent has no `buttons` bitmask field (checked electron.d.ts), and
	// without it the synthesized moves carry buttons=0, so the browser's own drag
	// tracking (which rrp's pointer-capture handler reads via event.buttons) never
	// sees the button as held and ignores the moves as a live drag.
	const send = (type, x, y, modifiers = []) =>
		mainWin.webContents.sendInputEvent({
			type,
			x,
			y,
			button: 'left',
			clickCount: type === 'mouseMove' ? 0 : 1,
			modifiers,
		})
	let x = handleRect.x
	const y = handleRect.y
	send('mouseDown', x, y)
	await sleep(16)
	for (let round = 0; round < rounds; round++) {
		for (let step = 0; step < 5; step++) {
			x += 4
			send('mouseMove', x, y, ['leftbuttondown'])
			await sleep(8)
		}
		if (round === 0 && onPeak) onPeak()
		if (!returnToStart && round === rounds - 1) break
		for (let step = 0; step < 5; step++) {
			x -= 4
			send('mouseMove', x, y, ['leftbuttondown'])
			await sleep(8)
		}
	}
	send('mouseUp', x, y)
	return { handleRect }
}

// Drive Chromium's actual HTML drag-and-drop path. We deliberately do not
// synthesize DragEvents in the renderer: this validates the BrowserWindow input
// route, native drag threshold, DataTransfer payload, and DockView handlers as
// one user-visible interaction.
async function driveTabDrag(mainWin, { panelId, targetGroupId, targetPanelId, zone }) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)
	const sourceSelector = `[data-deck-tab=${JSON.stringify(panelId)}]`
	const targetSelector = targetPanelId
		? `[data-deck-tab=${JSON.stringify(targetPanelId)}]`
		: `[data-deck-group=${JSON.stringify(targetGroupId)}]`
	const points = await js(`
		(() => {
			window.__dockE2EDragEvents = []
			if (!window.__dockE2EDragListenersInstalled) {
				window.__dockE2EDragListenersInstalled = true
				for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
					document.addEventListener(type, (event) => {
						window.__dockE2EDragEvents.push({
							type,
							target: event.target?.getAttribute?.('data-deck-tab') || event.target?.getAttribute?.('data-deck-group') || event.target?.tagName,
							panelData: type === 'dragstart' ? event.dataTransfer?.getData('application/x-deck-panel') : undefined,
						})
					}, { capture: type !== 'dragstart' })
				}
			}
			const source = document.querySelector(${JSON.stringify(sourceSelector)})
			const target = document.querySelector(${JSON.stringify(targetSelector)})
			if (!source || !target) return null
			const s = source.getBoundingClientRect()
			const t = target.getBoundingClientRect()
			if (!s.width || !s.height || !t.width || !t.height) return null
			const start = { x: s.x + s.width / 2, y: s.y + s.height / 2 }
			const end = ${JSON.stringify(zone)} === 'left'
				? { x: t.x + Math.min(8, t.width * 0.05), y: t.y + t.height / 2 }
				: { x: t.x + t.width / 2, y: t.y + t.height / 2 }
			return { start, end, source: { x: s.x, y: s.y, width: s.width, height: s.height }, target: { x: t.x, y: t.y, width: t.width, height: t.height } }
		})()
	`)
	if (!points) return null
	const send = (type, x, y, modifiers = []) =>
		mainWin.webContents.sendInputEvent({
			type,
			x,
			y,
			button: 'left',
			clickCount: type === 'mouseMove' ? 0 : 1,
			modifiers,
		})
	send('mouseDown', points.start.x, points.start.y)
	await sleep(40)
	// This real pointer move crosses Chromium's drag threshold, running the tab's
	// onDragStart handler and proving the source-side browser input path.
	const dx = Math.sign(points.end.x - points.start.x) || 1
	send('mouseMove', points.start.x + dx * 16, points.start.y, ['leftbuttondown'])
	await sleep(100)
	const sourceEvents = await js('window.__dockE2EDragEvents')
	if (!sourceEvents.some((event) => event.type === 'dragstart' && event.panelData === panelId)) {
		return { ...points, events: sourceEvents }
	}

	// Electron's sendInputEvent starts an HTML5 drag but does not reliably route
	// subsequent drag-over targets in an automated desktop session. Continue at
	// Chromium's browser-input layer with the same deck payload and real DOM
	// geometry. This is deliberately NOT a renderer dispatchEvent or DockView seam.
	const dbg = mainWin.webContents.debugger
	let attachedHere = false
	try {
		if (!dbg.isAttached()) {
			dbg.attach('1.3')
			attachedHere = true
		}
		const data = {
			items: [
				{ mimeType: 'application/x-deck-panel', data: panelId },
				{ mimeType: 'text/plain', data: panelId },
			],
			dragOperationsMask: 1,
		}
		for (const type of ['dragEnter', 'dragOver', 'drop']) {
			await dbg.sendCommand('Input.dispatchDragEvent', { type, x: points.end.x, y: points.end.y, data })
			await sleep(40)
		}
	} finally {
		if (attachedHere) dbg.detach()
		send('mouseUp', points.end.x, points.end.y)
	}
	await sleep(100)
	return { ...points, events: await js('window.__dockE2EDragEvents') }
}

// ── OPTIONAL: CPU profile capture (forensic; gated by DECK_DEMO_PROFILE=1) ───
// Two scenarios feeding the react-resizable-panels layout path: (A) the same
// programmatic setHostWidth churn PROOF 2 uses, and (B) a real pointer drag on
// a resize handle via sendInputEvent (mousedown → mousemoves → mouseup), so the
// pointer-event drag path (not just the imperative resize API) is sampled too.
// Writes raw .cpuprofile files under shots/ for offline analysis; does not
// touch the PROOF 1–3 assertions or the demo's exit code.
async function captureProfiles(mainWin) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)
	const dbg = mainWin.webContents.debugger
	try {
		dbg.attach('1.3')
	} catch (e) {
		log('[profile] debugger.attach failed:', String(e))
		return
	}
	await dbg.sendCommand('Profiler.enable')
	await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 100 })

	// ── scenario A: setHostWidth churn (mirrors PROOF 2's imperative resize) ──
	log('[profile] scenario A: setHostWidth churn — starting')
	await dbg.sendCommand('Profiler.start')
	for (let i = 0; i < 40; i++) {
		await js(`window.__deck.setHostWidth(${i % 2 === 0 ? 880 : 520})`)
		await sleep(50)
	}
	const profileA = await dbg.sendCommand('Profiler.stop')
	writeFileSync(join(SHOTS, 'profile-hostwidth.cpuprofile'), JSON.stringify(profileA.profile))
	log('[profile] scenario A: wrote profile-hostwidth.cpuprofile,', String(profileA.profile.samples?.length ?? 0), 'samples')

	// Restore a sane width before locating the drag handle for scenario B.
	await js(`window.__deck.setHostWidth(900)`)
	await sleep(200)

	// ── scenario B: real pointer drag on a resize handle (driveSplitDrag) ─────
	const baseline = simBounds()
	log('[profile] scenario B: simBounds before drag:', JSON.stringify(baseline))
	let peak = null
	await dbg.sendCommand('Profiler.start')
	const dragResult = await driveSplitDrag(mainWin, {
		rounds: 40,
		onPeak: () => {
			peak = simBounds()
			log('[profile] scenario B: simBounds at peak displacement (round 0, +20px from start):', JSON.stringify(peak))
		},
	})
	const profileB = await dbg.sendCommand('Profiler.stop')
	if (!dragResult) {
		log('[profile] scenario B: no resize-handle element found via [data-deck-resize-handle], [data-panel-resize-handle-id], or [data-resize-handle] — skipping drag scenario')
	} else {
		log('[profile] scenario B: pointer drag on resize handle at', JSON.stringify(dragResult.handleRect), '— done')
		await sleep(50)
		const after = simBounds()
		log('[profile] scenario B: simBounds after mouseUp (round-tripped back to start x):', JSON.stringify(after))
		const moved = !!(baseline && peak && baseline.width !== peak.width)
		log(
			'[profile] scenario B: drag',
			moved ? 'MOVED the split (peak width differs from baseline)' : 'did NOT move the split — peak width equals baseline, sendInputEvent had no effect',
			'| Δwidth(baseline→peak) =',
			String(baseline && peak ? baseline.width - peak.width : null),
		)
		if (moved) {
			writeFileSync(join(SHOTS, 'profile-drag.cpuprofile'), JSON.stringify(profileB.profile))
			log('[profile] scenario B: wrote profile-drag.cpuprofile,', String(profileB.profile.samples?.length ?? 0), 'samples')
		} else {
			log('[profile] scenario B: NOT writing profile-drag.cpuprofile — drag had no measurable effect, data would be invalid')
		}
	}

	dbg.detach()
	log('[profile] done')
}

// ── OPTIONAL: DOM-slot vs native-view lag measurement (gated by DECK_DEMO_LAG=1)
// Samples BOTH sides of the placement pipeline during a real pointer drag
// (driveSplitDrag): the renderer's DOM slot rect once per rAF, and the main
// process's native WCV bounds every time simBounds() changes (1-2ms poll).
// Both timestamps are wall-clock ms since epoch (renderer: performance.timeOrigin
// + performance.now(); main: Date.now()), directly comparable within ±1ms.
function logLagReport(r) {
	const ms = (v) => (v === null ? 'NA' : v.toFixed(1))
	const frames = (v) => (v === null || !r.medianInterval ? 'NA' : (v / r.medianInterval).toFixed(1))
	log(`[lag] domFrames=${r.frameCount} medianRafIntervalMs=${ms(r.medianInterval)}`)
	log(`[lag] rAF interval p95=${ms(r.domIntervalP95)} p99=${ms(r.domIntervalP99)} samples=${r.domIntervalSamples}`)
	log(
		`[lag] misalignedFrames=${r.misaligned}/${r.comparable}`,
		`(${r.comparable ? ((100 * r.misaligned) / r.comparable).toFixed(1) : 'NA'}%)`,
	)
	log(`[lag] nativeBoundsChanges=${r.nativeChangeCount} domWidthChanges=${r.domChangeCount}`)
	log(
		`[lag] lag(ms) median=${ms(r.lagMedian)} p90=${ms(r.lagP90)} p95=${ms(r.lagP95)} p99=${ms(r.lagP99)} max=${ms(r.lagMax)}`,
		`| lag(frames) median=${frames(r.lagMedian)} p90=${frames(r.lagP90)} max=${frames(r.lagMax)}`,
		`| caughtUp=${r.lagSamples} uncaught=${r.uncaught}`,
	)
	log(`[lag] P99 sample sufficiency: lag=${r.lagSamples} (${r.lagP99InsufficientSamples ? 'insufficient: need 100+' : 'sufficient'})`)
	if (r.eventLoopDelay) log(`[lag] event-loop delay p95=${ms(r.eventLoopDelay.p95Ms)} p99=${ms(r.eventLoopDelay.p99Ms)} samples=${r.eventLoopDelay.sampleCount} (${r.eventLoopDelay.p99InsufficientSamples ? 'insufficient: need 100+' : 'sufficient'})`)
}

async function measureDragLag(mainWin) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)
	await js(`window.__deck.setHostWidth(900)`)
	await sleep(300)

	// Renderer side: one rAF-driven sample of the DOM slot's rect per frame.
	await js(`
		(function(){
			window.__deckLagSamples = [];
			window.__deckLagRunning = true;
			const slot = document.querySelector('[data-deck-native-slot="simulator"]');
			function frame() {
				if (!window.__deckLagRunning) return;
				const r = slot.getBoundingClientRect();
				window.__deckLagSamples.push({
					t: performance.timeOrigin + performance.now(),
					x: r.x, y: r.y, w: r.width, h: r.height,
				});
				requestAnimationFrame(frame);
			}
			requestAnimationFrame(frame);
		})();
	`)

	// Main side: poll simBounds() at 2ms, recording only actual changes.
	const nativeSamples = []
	let lastB = simBounds()
	if (lastB) nativeSamples.push({ t: Date.now(), width: lastB.width, x: lastB.x })
	const pollTimer = setInterval(() => {
		const b = simBounds()
		if (!b) return
		if (!lastB || b.width !== lastB.width || b.x !== lastB.x) {
			nativeSamples.push({ t: Date.now(), width: b.width, x: b.x })
			lastB = b
		}
	}, 2)
	const eventLoop = monitorEventLoopDelay({ resolution: 10 })
	eventLoop.enable()
	let domSamples = []
	try {
		await driveSplitDrag(mainWin, { rounds: 40 })
		domSamples = await js('window.__deckLagSamples')
	} finally {
		clearInterval(pollTimer)
		try {
			await js('window.__deckLagRunning = false')
		} finally {
			eventLoop.disable()
		}
	}

	const eventLoopStats = {
		sampleCount: Number(eventLoop.count),
		p95Ms: eventLoop.percentile(95) / 1e6,
		p99Ms: eventLoop.percentile(99) / 1e6,
	}
	const report = createLagReport(analyzeLag(domSamples, nativeSamples), eventLoopStats)
	logLagReport(report)
	writeFileSync(join(SHOTS, 'lag-report.json'), JSON.stringify(report, null, 2))
	log('[lag] wrote structured report:', join(SHOTS, 'lag-report.json'))

	await js(`window.__deck.setHostWidth(900)`)
	await sleep(200)
}

function assertE2E(condition, label, details) {
	log(condition ? `✅ E2E ${label}` : `❌ E2E ${label}`, details)
	if (!condition) throw new Error(`E2E assertion failed: ${label}; ${details}`)
}

async function e2eSnapshot(mainWin) {
	return mainWin.webContents.executeJavaScript(`
		(() => {
			const tree = window.__deck.model().get()
			const groups = Object.fromEntries(
				Array.from(document.querySelectorAll('[data-deck-group]')).map((group) => [
					group.getAttribute('data-deck-group'),
					Array.from(group.querySelectorAll(':scope [data-deck-tab]')).map((tab) => tab.getAttribute('data-deck-tab')),
				])
			)
			const countSplits = (node) => node.kind === 'split'
				? 1 + node.children.reduce((count, child) => count + countSplits(child), 0)
				: 0
			return {
				serialized: window.__deck.serializeLayout(tree),
				rootSizes: tree.root.kind === 'split' ? tree.root.sizes : null,
				groups,
				splitCount: countSplits(tree.root),
				documentFocused: document.hasFocus(),
			}
		})()
	`)
}

async function waitForDocumentLoad(mainWin, label) {
	if (!mainWin.webContents.isLoading()) return
	await new Promise((resolve, reject) => {
		const done = (settle) => {
			mainWin.webContents.off('did-finish-load', finish)
			mainWin.webContents.off('did-fail-load', fail)
			settle()
		}
		const finish = () => done(resolve)
		const fail = (_event, code, description) => done(() => reject(new Error(`${label} failed: ${code} ${description}`)))
		mainWin.webContents.once('did-finish-load', finish)
		mainWin.webContents.once('did-fail-load', fail)
	})
}

async function waitForDeckState(mainWin, label, timeoutMs = 8_000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		try {
			const state = await mainWin.webContents.executeJavaScript(`
				(() => {
					const slot = document.querySelector('[data-deck-native-slot="simulator"]')
					return {
						deck: !!window.__deck,
						slot: slot ? (() => { const r = slot.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })() : null,
					}
				})()
			`)
			if (state.deck && state.slot && state.slot.width > 0 && state.slot.height > 0) return state
		} catch {}
		await sleep(25)
	}
	throw new Error(`${label} did not expose a usable window.__deck/native slot within ${timeoutMs}ms`)
}

function nativeFollowCheck(mainWin, state, label) {
	const bounds = simBounds()
	const valid = !!bounds && bounds.width > 0 && state.slot.width > 0 && state.slot.height > 0
	const follows = valid && Math.abs(bounds.width - state.slot.width) <= 8
	assertE2E(valid, `${label} native simulator bounds`, JSON.stringify({ state, bounds }))
	assertE2E(follows, `${label} native simulator follows slot`, JSON.stringify({ slot: state.slot, bounds }))
}

async function waitForNativeFollow(mainWin, label, timeoutMs = 4_000) {
	const started = Date.now()
	const samples = []
	while (Date.now() - started < timeoutMs) {
		try {
			const state = await waitForDeckState(mainWin, `${label} slot`, 250)
			const bounds = simBounds()
			samples.push({ at: Date.now() - started, slot: state.slot.width, view: bounds ? bounds.width : null })
			if (bounds && Math.abs(bounds.width - state.slot.width) <= 8) return { state, bounds }
		} catch (err) {
			samples.push({ at: Date.now() - started, err: String(err && err.message ? err.message : err) })
		}
		await sleep(25)
	}
	// A bare timeout cannot tell "the view never moved" from "it moved, later
	// than this window allows", and the two need opposite fixes. Carry the
	// trajectory into the failure: first samples, last samples, nothing in
	// between, so the log stays readable.
	const trail = samples.length <= 8 ? samples : [...samples.slice(0, 3), '...', ...samples.slice(-4)]
	throw new Error(
		`${label} native simulator did not follow the slot within ${timeoutMs}ms; samples=${JSON.stringify(trail)}`,
	)
}

async function runE2ERecoveryVerification(mainWin) {
	const mode = String(E2E_RECOVERY || '').trim().toLowerCase()
	const allowed = new Set(['reload', 'navigate', 'crash', 'untrusted-navigation'])
	if (!allowed.has(mode)) {
		log(`❌ E2E recovery mode must be one of reload, navigate, crash, untrusted-navigation; got ${JSON.stringify(E2E_RECOVERY)}`)
		throw new Error('invalid E2E recovery mode')
	}
	await rendererReady
	await waitForDeckState(mainWin, 'initial recovery setup')
	if (mode === 'untrusted-navigation') {
		await mainWin.webContents.loadURL('about:blank')
		await mainWin.webContents.executeJavaScript(`window.__demoControl.openProject('untrusted-navigation')`)
		await sleep(300)
		assertE2E(rejectedOpenProjects > 0, 'untrusted navigation cannot regrant native slot', JSON.stringify({ rejectedOpenProjects }))
		recoveryStatus = 'passed'
		log('✅ E2E security PASS (untrusted-navigation)')
		return
	}
	const before = await e2eSnapshot(mainWin)
	const firstDrag = await driveSplitDrag(mainWin, { rounds: 1, returnToStart: false })
	await sleep(250)
	const beforeRecovery = await e2eSnapshot(mainWin)
	assertE2E(!!firstDrag && before.serialized !== beforeRecovery.serialized, `${mode} pre-recovery drag`, JSON.stringify({ before, after: beforeRecovery }))

	log(`[recovery] starting ${mode}`)
	if (mode === 'reload') {
		const nextReady = waitForRendererReady(mode)
		mainWin.webContents.reload()
		await nextReady
		await waitForDocumentLoad(mainWin, mode)
	} else if (mode === 'navigate') {
		await mainWin.webContents.loadURL('about:blank')
		const nextReady = waitForRendererReady(mode)
		await mainWin.webContents.loadURL(INDEX)
		await nextReady
	} else {
		if (typeof mainWin.webContents.forcefullyCrashRenderer !== 'function') {
			log('⚠️ E2E recovery condition unmet: forcefullyCrashRenderer is unavailable in this Electron')
			recoveryStatus = 'condition-unmet'
			failed = true
			return
		}
		const crashed = new Promise((resolve) => mainWin.webContents.once('render-process-gone', (_event, details) => resolve(details)))
		try {
			mainWin.webContents.forcefullyCrashRenderer()
		} catch (error) {
			log('⚠️ E2E recovery condition unmet: forcefullyCrashRenderer threw:', String(error))
			recoveryStatus = 'condition-unmet'
			failed = true
			return
		}
		const details = await Promise.race([
			crashed,
			new Promise((_, reject) => setTimeout(() => reject(new Error('forcefullyCrashRenderer did not emit render-process-gone within 8s')), 8_000)),
		])
		log('[recovery] renderer crashed:', JSON.stringify(details))
		const nextReady = waitForRendererReady(mode)
		mainWin.webContents.reload()
		await nextReady
	}

	const recoveredFollow = await waitForNativeFollow(mainWin, `${mode} recovery`)
	const recovered = recoveredFollow.state
	nativeFollowCheck(mainWin, recovered, mode)
	const afterRecovery = await e2eSnapshot(mainWin)
	const secondDrag = await driveSplitDrag(mainWin, { rounds: 1, returnToStart: false })
	await sleep(250)
	const afterSecondDrag = await e2eSnapshot(mainWin)
	assertE2E(
		!!secondDrag && afterRecovery.serialized !== afterSecondDrag.serialized,
		`${mode} second post-recovery split drag`,
		JSON.stringify({ secondDrag, before: afterRecovery, after: afterSecondDrag }),
	)
	const postDragFollow = await waitForNativeFollow(mainWin, `${mode} post-drag`)
	assertE2E(
		postDragFollow.state.slot.width !== recovered.slot.width,
		`${mode} post-recovery drag changes slot size`,
		JSON.stringify({ before: recovered.slot, after: postDragFollow.state.slot }),
	)
	nativeFollowCheck(mainWin, postDragFollow.state, `${mode} post-recovery drag`)
	log(`✅ E2E recovery PASS (${mode})`)
	recoveryStatus = 'passed'
}

// E2E mode intentionally covers only input-driven behavior. The ordinary demo
// still proves the broader tab/native/restore showcase without requiring a
// focused desktop window.
async function runE2EVerification(mainWin) {
	await rendererReady
	await sleep(900)
	const initial = await e2eSnapshot(mainWin)
	assertE2E(initial.documentFocused, 'window focus', JSON.stringify({ window: mainWin.isFocused(), document: initial.documentFocused }))
	await captureE2EMetrics(mainWin, 'before-drag')

	// A completed separator drag must persist a new model split ratio, not merely
	// resize react-resizable-panels' transient DOM layout.
	const beforeFollow = await waitForNativeFollow(mainWin, 'pre-split-drag')
	const beforeBounds = beforeFollow.bounds
	const splitDrag = await driveSplitDrag(mainWin, { rounds: 1, returnToStart: false })
	await sleep(500)
	const afterSplit = await e2eSnapshot(mainWin)
	await captureE2EMetrics(mainWin, 'after-drag')
	assertE2E(
		!!splitDrag
			&& initial.serialized !== afterSplit.serialized
			&& JSON.stringify(initial.rootSizes) !== JSON.stringify(afterSplit.rootSizes),
		'split drag writes model layout',
		JSON.stringify({ splitDrag, beforeSizes: initial.rootSizes, afterSizes: afterSplit.rootSizes, beforeBounds }),
	)

	// The assertion above only proves the model and the DOM moved. Placement's
	// whole job is that the native view tracks its DOM slot, so gate that on its
	// own: stop the publisher from sending, make reconcile drop the setBounds, or
	// break the native apply, and the model still moves — only the three checks
	// below go red. The drag leaves a net +20px, well outside the 8px tolerance.
	const afterFollow = await waitForNativeFollow(mainWin, 'split drag')
	assertE2E(
		afterFollow.state.slot.width !== beforeFollow.state.slot.width,
		'split drag resizes the native slot',
		JSON.stringify({ before: beforeFollow.state.slot, after: afterFollow.state.slot }),
	)
	assertE2E(
		!!beforeBounds && afterFollow.bounds.width !== beforeBounds.width,
		'split drag moves the native view',
		JSON.stringify({ before: beforeBounds, after: afterFollow.bounds }),
	)
	nativeFollowCheck(mainWin, afterFollow.state, 'split drag')

	if (E2E_METRICS) {
		// Keep this bounded and use the same sendInputEvent pointer path as the
		// user-facing split drag. These samples are diagnostic evidence only.
		for (let round = 0; round < metricsReport.repeatedDragRounds; round++) {
			await captureE2EMetrics(mainWin, `repeat-drag-${round}-before`)
			await driveSplitDrag(mainWin, { rounds: 1, returnToStart: true })
			await captureE2EMetrics(mainWin, `repeat-drag-${round}-after`)
		}
	}

	// Drop logs on the left edge of its sibling group. This is a real HTML DnD
	// gesture; the resulting extra split demonstrates a structural model and DOM
	// mutation rather than a visual drop indicator alone.
	const leftDrag = await driveTabDrag(mainWin, {
		panelId: 'logs',
		targetGroupId: 'g-right',
		zone: 'left',
	})
	await sleep(500)
	const afterLeft = await e2eSnapshot(mainWin)
	assertE2E(
		!!leftDrag
			&& completedTabDrag(leftDrag, 'logs')
			&& afterLeft.serialized !== afterSplit.serialized
			&& afterLeft.splitCount > afterSplit.splitCount
			&& documentContains(afterLeft.groups, 'logs'),
		'tab drag to left mutates DOM and model',
		JSON.stringify({ leftDrag, before: afterSplit, after: afterLeft }),
	)

	// Then join that real tab into the left tab strip (the center-drop path).
	// Targeting Simulator's visible tab avoids the native view body overlay while
	// still exercising the tab-strip's browser drag/drop handler.
	const centerDrag = await driveTabDrag(mainWin, {
		panelId: 'logs',
		targetGroupId: 'g-left',
		targetPanelId: 'simulator',
		zone: 'center',
	})
	await sleep(500)
	const afterCenter = await e2eSnapshot(mainWin)
	assertE2E(
		!!centerDrag
			&& completedTabDrag(centerDrag, 'logs')
			&& afterCenter.serialized !== afterLeft.serialized
			&& afterCenter.groups['g-left']?.includes('logs')
			&& documentContains(afterCenter.groups, 'logs'),
		'tab drag to center mutates DOM and model',
		JSON.stringify({ centerDrag, before: afterLeft, after: afterCenter }),
	)

	await shot(mainWin, 'e2e-final.png')
	log('✅ E2E PASS')
}

function documentContains(groups, panelId) {
	return Object.values(groups).some((panels) => panels.includes(panelId))
}

function completedTabDrag(drag, panelId) {
	const events = drag.events
	if (!events.some((event) => event.type === 'dragstart' && event.panelData === panelId)) return false
	let previous = -1
	for (const type of ['dragstart', 'dragenter', 'dragover', 'drop']) {
		const index = events.findIndex((event, at) => at > previous && event.type === type)
		if (index < 0) return false
		previous = index
	}
	return true
}

// ── offscreen verification: the three proofs ─────────────────────────────────
async function runVerification(mainWin) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)

	// Wait for the React app to mount + open the project (places the native block).
	await rendererReady
	// Give the open-project IPC + placeIn + SlotGrant + anchor measure a beat.
	await sleep(800)
	await shot(mainWin, '1-initial.png')

	// ── PROOF 1: DOM tab switch ───────────────────────────────────────────────
	// Click the logs tab in g-right; assert model g-right active === 'logs',
	// the logs body is visible, and the editor body is still mounted but
	// hidden (DockView leaves inactive panel DOM in place — see
	// panel-body.tsx — rather than removing it).
	log('── PROOF 1: DOM tab switch (g-right editor → logs) ──')
	const beforeActive = await js(`window.__deck.activeOf('g-right')`)
	await js(`document.querySelector('[data-deck-tab="logs"]').click()`)
	await sleep(300)
	const afterActive = await js(`window.__deck.activeOf('g-right')`)
	const logsBodyVisible = await js(
		`!!document.querySelector('[data-deck-panel-body="logs"] [data-test-dom-content="logs"]') && getComputedStyle(document.querySelector('[data-deck-panel-body="logs"]')).display !== 'none'`,
	)
	const editorBodyHidden = await js(
		`!!document.querySelector('[data-deck-panel-body="editor"]') && getComputedStyle(document.querySelector('[data-deck-panel-body="editor"]')).display === 'none'`,
	)
	const tabActive = await js(
		`document.querySelector('[data-deck-tab="logs"]').getAttribute('data-active') === 'true'`,
	)
	log('PROOF1: g-right active', beforeActive, '→', afterActive, '| logsVisible', String(logsBodyVisible), '| editorHidden', String(editorBodyHidden), '| tabActive', String(tabActive))
	if (afterActive === 'logs' && logsBodyVisible && editorBodyHidden && tabActive) {
		log('✅ DOM tab switch: clicking [data-deck-tab="logs"] flipped the model, showed the logs body, and left the editor body mounted-but-hidden.')
	} else {
		log('❌ DOM tab switch did NOT propagate to the model/DOM.')
	}
	await shot(mainWin, '2-after-tab-switch.png')

	// ── PROOF 2: native slot following ────────────────────────────────────────
	// Resize the dock host (renderer-driven): react-resizable-panels re-distributes
	// the left (simulator) panel → the native slot rect changes → the view-anchor
	// re-publishes → the framework moves the native WCV. Assert the native sim
	// block's width SHRANK to track its slot. Zero host resize code.
	log('── PROOF 2: native slot following (renderer-driven resize) ──')
	await js(`window.__deck.setHostWidth(880)`)
	await sleep(700)
	const before = simBounds()
	log('PROOF2: native sim bounds @hostWidth=880 :', JSON.stringify(before))
	await js(`window.__deck.setHostWidth(520)`)
	await sleep(700)
	const after = simBounds()
	log('PROOF2: native sim bounds @hostWidth=520 :', JSON.stringify(after))
	await shot(mainWin, '3-after-resize.png')

	// The left panel is ~half the dock host (rrp 50/50). Host 880→520 shrinks the
	// left region by ~180px; the native sim slot (minus CSS margins) tracks it.
	const simDelta = before && after ? before.width - after.width : 0
	const simTracked = simDelta > 100 && simDelta < 260 // ~180 expected, generous band
	log('PROOF2: native sim widthΔ =', String(simDelta), '(expect ~180; band 100..260)')
	if (simTracked) {
		log('✅ native slot following: the native simulator WCV tracked the dock slot rect (renderer-driven geometry, zero host resize code).')
	} else {
		log('❌ native simulator block did NOT follow the dock slot resize.')
	}

	if (process.env.DECK_DEMO_PROFILE === '1') {
		await captureProfiles(mainWin)
	}

	if (process.env.DECK_DEMO_LAG === '1') {
		await measureDragLag(mainWin)
	}

	// ── PROOF 3: serialize / restore ──────────────────────────────────────────
	// Move 'logs' to the left group (cross-group move via the model API), then
	// serialize → teardown → parse+validate → rebuild fresh. Assert the restored
	// DOM reflects the persisted tree: g-right active was 'logs' before the move;
	// after the move 'logs' lives in g-left. The restored tree must preserve that
	// 'logs' is in g-left and that the previously-activated state round-tripped.
	log('── PROOF 3: serialize / restore ──')
	// First restore the simulator slot to a sane width so re-mount re-anchors.
	await js(`window.__deck.setHostWidth(900)`)
	await sleep(200)
	// move logs into the left group (so the persisted tree differs from default).
	await js(`window.__deck.moveLogsLeft()`)
	await sleep(200)
	const preLogsInLeft = await js(
		`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="logs"]')`,
	)
	const persistedJson = await js(`window.__deck.serializeLayout(window.__deck.model().get())`)
	log('PROOF3: pre-restore — logs tab in g-left:', String(preLogsInLeft))
	log('PROOF3: serialized tree:', persistedJson)

	const restore = await js(`window.__deck.serializeRestore()`)
	if (!restore.ok) {
		log('PROOF3: parseLayout/validateTree FAILED:', JSON.stringify(restore.problems))
		log('❌ serialize/restore: validation rejected the persisted tree.')
	} else {
		await sleep(400)
		const postLogsInLeft = await js(
			`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="logs"]')`,
		)
		const postSimSlot = await js(
			`!!document.querySelector('[data-deck-native-slot="simulator"]')`,
		)
		log('PROOF3: post-restore — logs tab in g-left:', String(postLogsInLeft), '| native slot present:', String(postSimSlot))
		if (postLogsInLeft && postSimSlot) {
			log('✅ serialize/restore: persisted tree round-tripped through serializeLayout→parseLayout→validateTree and the rebuilt DockView reflects it (logs in g-left, native slot intact).')
		} else {
			log('❌ serialize/restore: restored DOM did NOT reflect the persisted tree.')
		}
	}
	await shot(mainWin, '4-after-restore.png')

	log('ALL STEPS DONE')
}

void allDone.then(async () => {
	log('[verification] exiting')
	await sleep(200)
	quitting = true
	// Electron's app.quit() ignores process.exitCode (verified: a forced ❌ still
	// exited 0), so E2E forces its terminal code via app.exit() after writing its
	// diagnostics. The interactive demo keeps its graceful app.quit() path.
	if (E2E) {
		const code = failed ? 1 : 0
		if (E2E_METRICS) {
			writeFileSync(join(SHOTS, 'e2e-metrics.json'), JSON.stringify(metricsReport, null, 2) + '\n')
			log('[metrics] wrote e2e-metrics.json samples=', String(metricsReport.samples.length))
		}
		writeFileSync(join(SHOTS, 'e2e-result.json'), JSON.stringify({ success: code === 0, recovery: recoveryStatus }) + '\n')
		log('[e2e] result ready')
		// A live WebContentsView can keep the macOS Electron helper alive after
		// app.exit(). E2E has already synchronously written its trace, so force a
		// definitive terminal code instead of making the wrapper's 60s watchdog win.
		process.exit(code)
	} else if (failed) app.exit(1)
	else app.quit()
})

app.on('window-all-closed', () => {
	if (failed) app.exit(1)
	else app.quit()
})
process.on('uncaughtException', (e) => {
	failed = true
	console.error('[demo] UNCAUGHT', e)
	try {
		appendFileSync(TRACE, '[demo] UNCAUGHT ' + String(e && e.stack ? e.stack : e) + '\n')
	} catch {}
	app.exit(1)
})
