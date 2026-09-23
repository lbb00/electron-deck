// electron-deck DOCKABLE demo — host (offscreen, self-verifying).
//
// This is the P-1 fallback deliverable: a standalone Electron example proving
// the NEW React `<DockView>` dock-shell adapter drives a real docking UI with a
// native WebContentsView FOLLOWING a DOM slot, plus serialize/restore.
//
// Host wiring mirrors layout-demo/main.js (startElectronDeck, offscreen
// showInactive at -3000, native block via runtime.view().placeIn, composite
// screenshots, captureRetry). The KEY DIFFERENCE: the renderer DOM is driven by
// React <DockView> (not hand-rolled DOM), and the native preview block is
// anchored to the dock's native slot selector [data-deck-native-slot="preview"].
//
// Run offscreen:  electron examples/dockable-demo/main.js
//
// Proves (with explicit ✅/❌ trace lines):
//   1. DOM tab switch — clicking [data-deck-tab="output"] flips g-right active to
//      'output' in the model, shows the output body, and leaves the doc body
//      mounted-but-hidden (DockView keeps inactive panel DOM around to
//      preserve React state/scroll — see panel-body.tsx).
//   2. Native slot following — resizing the dock host (renderer-driven) moves
//      the native preview WebContentsView to track its slot rect.
//   3. Serialize/restore — serialize (after tab switch + movePanel), teardown,
//      parseLayout + collectTreeProblems, rebuild a fresh model+DockView, assert the
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
// demo:ready (React mounted + client live), and the native preview view's
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
// firstPlacementPoll (below) runs at module scope, before assemble() has a
// mainWin to hand it — assemble() fills this in as soon as it has one.
let mainWinRef = null

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
			if (block.label !== 'PREVIEW' || block.handle.webContents.isDestroyed()) continue
			refs.push({ role: 'native-preview', pid: block.handle.webContents.getOSProcessId() })
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

// 5ms poll for the native preview view's first non-zero-size bounds — the
// last of the four [startup] cold-start points (see maybeEmitStartupLine).
// Reads the ACTUAL attached view via previewBounds(), not the requested
// placement, so this timestamp means "the view really has pixels" rather
// than "someone asked for a placement".
const firstPlacementPoll = setInterval(() => {
	if (startupTimes.firstPlacement !== null) {
		clearInterval(firstPlacementPoll)
		return
	}
	if (!mainWinRef) return
	const { attached, bounds } = previewBounds(mainWinRef)
	if (attached && bounds && bounds.width > 0 && bounds.height > 0) {
		startupTimes.firstPlacement = since()
		maybeEmitStartupLine()
		clearInterval(firstPlacementPoll)
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
		// Raw, uncomposited proof: exactly what capturePage() sees on the window
		// itself, with none of the manual compositing math below applied. The
		// composite image below trusts attachedBounds() to place each block's
		// screenshot — if that's ever wrong, this raw shot is the only artifact
		// that would still show it.
		await writeFile(join(SHOTS, name.replace(/\.png$/, '-raw.png')), hostImg.toPNG())
		const ordered = [...placedBlocks].sort((a, b) => a.zone - b.zone)
		const blocks = []
		for (const blk of ordered) {
			if (blk.handle.webContents.isDestroyed()) continue
			const { attached, bounds: b } = attachedBounds(win, blk)
			if (!attached || !b || b.width === 0 || b.height === 0) continue
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
			mainWinRef = mainWin

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
					const block = placedBlocks.find((candidate) => candidate.label === 'PREVIEW')
					if (!block) {
						failed = true
						log('❌ open-project recovery: PREVIEW handle is missing')
						return
					}
					recoveryMove = recoveryMove.then(async () => {
						log('open-project recovery:', projectId)
						await block.handle.moveTo(mainWin, { zone: 0, anchor: '[data-deck-native-slot="preview"]' })
						log('open-project recovery: PREVIEW re-anchored')
					}).catch((error) => {
						failed = true
						log('❌ open-project recovery failed:', String(error))
					})
					return
				}
				log('open-project:', projectId)
				session = main.newSession()
				const handle = runtime
					.view({ source: { url: `${BLOCK}#${enc('#c0392b', 'PREVIEW')}` }, scope: session })
					.placeIn(mainWin, { zone: 0, anchor: '[data-deck-native-slot="preview"]' })
				placedBlocks.push({ handle, label: 'PREVIEW', zone: 0 })
				log('placed native PREVIEW view; placedBlocks =', String(placedBlocks.length))
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

// blk.handle.bounds() only echoes the LAST bounds view-handle.ts was asked to
// apply (view-handle.ts:401/455-458) — it never reads the native view back, so
// it proves nothing if setBounds silently failed, the view was never mounted,
// or DPI/placement math is wrong. This instead asks the window what it
// actually hosts: walk mainWin.contentView.children (flat — every view this
// demo places is a direct child, per compositor.ts's addChildView) for the one
// whose webContents.id matches the handle's, and read ITS getBounds(). A
// missing child (never attached to this window) is a different failure mode
// from "attached but the rect is wrong", so both are reported, not collapsed
// into one null.
function attachedBounds(mainWin, blk) {
	if (!blk || blk.handle.webContents.isDestroyed()) return { attached: false, bounds: null }
	const wantedId = blk.handle.webContents.id
	const child = mainWin.contentView.children.find((c) => c.webContents?.id === wantedId)
	if (!child) return { attached: false, bounds: null }
	const b = child.getBounds()
	return { attached: true, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } }
}

function previewBounds(mainWin) {
	const blk = placedBlocks.find((candidate) => candidate.label === 'PREVIEW')
	return attachedBounds(mainWin, blk)
}

// ── shared pointer-drag driver (real sendInputEvent drag on the split resize
// handle) — used by both the CPU-profile capture (scenario B) and the
// DECK_DEMO_LAG lag measurement, so the actual drag mechanics live in exactly
// one place. Returns null if no resize-handle element is found (nothing was
// dragged); otherwise drives mouseDown → `rounds` × (5×+4px, 5×-4px) →
// mouseUp and returns the handle's center point. `onPeak` (optional) fires
// once, right after round 0's forward half (i.e. at +20px peak displacement)
// — the CPU-profile capture uses it to sample previewBounds() at a known
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

// Exercise position-only following through Chromium pointer input and the real
// native child view. A vertical move keeps the horizontal split width fixed;
// translating the slot changes its viewport position without resizing it.
async function verifyPositionOnlyDrag(mainWin) {
	const js = (code) => mainWin.webContents.executeJavaScript(code)
	const handle = await js(`
		(() => {
			const el = document.querySelector('[data-deck-resize-handle]')
			const r = el?.getBoundingClientRect()
			return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
		})()
	`)
	assertE2E(!!handle, 'position-only drag has a separator', JSON.stringify({ handle }))
	const previousTransform = await js(`document.querySelector('[data-deck-native-slot="preview"]').style.transform`)
	const send = (type, y, modifiers = []) => mainWin.webContents.sendInputEvent({
		type, x: handle.x, y, button: 'left',
		clickCount: type === 'mouseMove' ? 0 : 1, modifiers,
	})
	send('mouseDown', handle.y)
	try {
		// The initial pulse must finish before moving the slot. Four browser
		// frames exceed the anchor's two steady frames without a timed sleep.
		await js(`new Promise(resolve => {
			let frames = 0
			const next = () => ++frames === 4 ? resolve() : requestAnimationFrame(next)
			requestAnimationFrame(next)
		})`)
		// The window can finish a separate layout adjustment during those four
		// frames. Confirm the native view caught up before measuring THIS movement.
		const before = await waitForNativeFollow(mainWin, 'pre-position-only-move', 12_000, true)
		const moved = await js(`
			(() => {
				const slot = document.querySelector('[data-deck-native-slot="preview"]')
				const measure = () => {
					const r = slot.getBoundingClientRect()
					return { x: r.x, y: r.y, width: r.width, height: r.height }
				}
				const from = measure()
				slot.style.transform = 'translateX(-32px)'
				return { from, to: measure() }
			})()
		`)
		assertE2E(
			Math.abs(moved.from.width - before.state.slot.width) < 1
				&& Math.abs(moved.from.height - before.state.slot.height) < 1
				&& Math.abs(moved.to.width - moved.from.width) < 1
				&& Math.abs(moved.to.height - moved.from.height) < 1
				&& Math.abs(moved.to.y - moved.from.y) < 1
				&& Math.abs(moved.to.x - moved.from.x + 32) < 1,
			'position-only drag moves the slot without resizing it',
			JSON.stringify({ before: before.state.slot, moved }),
		)
		// Space held movements by browser frames so each one can be delivered
		// before we sample the native view.
		for (let step = 1; step <= 5; step++) {
			send('mouseMove', handle.y + step * 4, ['leftbuttondown'])
			await js(`new Promise(resolve => requestAnimationFrame(resolve))`)
		}
		const followed = await waitForNativeFollow(mainWin, 'position-only drag', 12_000, true)
		assertE2E(
			Math.abs(followed.state.slot.width - moved.from.width) < 1
				&& Math.abs(followed.state.slot.height - moved.from.height) < 1
				&& before.bounds.x - followed.bounds.x >= 24,
			'position-only drag moves the native view after a pause',
			JSON.stringify({ before: before.bounds, after: followed.bounds, slot: followed.state.slot }),
		)
		nativeFollowCheck(mainWin, followed.state, 'position-only drag')
	} finally {
		try {
			await js(`document.querySelector('[data-deck-native-slot="preview"]').style.transform = ${JSON.stringify(previousTransform)}`)
		} finally {
			send('mouseUp', handle.y + 20)
		}
	}
	const restored = await waitForNativeFollow(mainWin, 'post-position-only-drag', 12_000, true)
	nativeFollowCheck(mainWin, restored.state, 'post-position-only-drag')
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
	// Once a drag starts, Chromium hands it to the platform's drag loop, which an
	// unattended session cannot run: the drag dies before any drop target sees it.
	// Input.setInterceptDrags keeps the drag inside the browser and reports its
	// payload as Input.dragIntercepted instead. The pointer gesture below stays
	// real either way — the protocol has no dragstart to dispatch, so this is the
	// only way to start one without depending on the desktop session.
	const dbg = mainWin.webContents.debugger
	let attachedHere = false
	let intercepted = null
	const onDragIntercepted = (_event, method, params) => {
		if (method === 'Input.dragIntercepted') intercepted = params.data
	}
	try {
		if (!dbg.isAttached()) {
			dbg.attach('1.3')
			attachedHere = true
		}
		dbg.on('message', onDragIntercepted)
		await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })

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

		// The intercepted payload is what the page itself put on the DataTransfer,
		// so carrying it into the drop proves DockView filled the deck payload. A
		// missing payload means the browser started the drag without reporting it,
		// which is a real failure of the interception path this drag depends on —
		// silently handing the test's own guess of the payload to the drop would
		// prove nothing about DockView, so this aborts instead of synthesizing one.
		assertE2E(!!intercepted, 'drag payload intercepted', JSON.stringify({ panelId, sourceEvents }))
		const data = intercepted
		log('[e2e] drag payload intercepted', JSON.stringify(data.items))
		for (const type of ['dragEnter', 'dragOver', 'drop']) {
			await dbg.sendCommand('Input.dispatchDragEvent', { type, x: points.end.x, y: points.end.y, data })
			await sleep(40)
		}
	} finally {
		dbg.removeListener('message', onDragIntercepted)
		// Leaving interception on would break every later real drag in this window.
		try {
			await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
		} catch {}
		if (attachedHere) dbg.detach()
		// Also releases the button when the drag never started and this returned early.
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
	const baseline = previewBounds(mainWin).bounds
	log('[profile] scenario B: previewBounds before drag:', JSON.stringify(baseline))
	let peak = null
	await dbg.sendCommand('Profiler.start')
	const dragResult = await driveSplitDrag(mainWin, {
		rounds: 40,
		onPeak: () => {
			peak = previewBounds(mainWin).bounds
			log('[profile] scenario B: previewBounds at peak displacement (round 0, +20px from start):', JSON.stringify(peak))
		},
	})
	const profileB = await dbg.sendCommand('Profiler.stop')
	if (!dragResult) {
		log('[profile] scenario B: no resize-handle element found via [data-deck-resize-handle], [data-panel-resize-handle-id], or [data-resize-handle] — skipping drag scenario')
	} else {
		log('[profile] scenario B: pointer drag on resize handle at', JSON.stringify(dragResult.handleRect), '— done')
		await sleep(50)
		const after = previewBounds(mainWin).bounds
		log('[profile] scenario B: previewBounds after mouseUp (round-tripped back to start x):', JSON.stringify(after))
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
// process's native WCV bounds every time previewBounds() changes (1-2ms poll).
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
			const slot = document.querySelector('[data-deck-native-slot="preview"]');
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

	// Main side: poll previewBounds() at 2ms, recording only actual changes.
	const nativeSamples = []
	let lastB = previewBounds(mainWin).bounds
	if (lastB) nativeSamples.push({ t: Date.now(), width: lastB.width, x: lastB.x })
	const pollTimer = setInterval(() => {
		const b = previewBounds(mainWin).bounds
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
					const slot = document.querySelector('[data-deck-native-slot="preview"]')
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
	const { attached, bounds } = previewBounds(mainWin)
	log(`[e2e] ${label} native bounds: slot=${JSON.stringify(state.slot)} view=${JSON.stringify(bounds)} attached=${attached}`)
	const valid = attached && !!bounds && bounds.width > 0 && state.slot.width > 0 && state.slot.height > 0
	// state.slot is document.getBoundingClientRect() (viewport CSS px); bounds is
	// the native view's mainWin.contentView getBounds() (window contentView px).
	// Measured identical across every check in this demo (no window-chrome or
	// DPI offset in this frameless, devicePixelRatio=1 setup — see report), so
	// all four dimensions compare directly against the slot with the same 8px
	// tolerance the width-only check used (empirically set — see comment below).
	const follows = valid
		&& Math.abs(bounds.x - state.slot.x) <= 8
		&& Math.abs(bounds.y - state.slot.y) <= 8
		&& Math.abs(bounds.width - state.slot.width) <= 8
		&& Math.abs(bounds.height - state.slot.height) <= 8
	assertE2E(valid, `${label} native preview bounds`, JSON.stringify({ state, bounds, attached }))
	assertE2E(follows, `${label} native preview follows slot`, JSON.stringify({ slot: state.slot, bounds }))
}

// The 8px tolerance is the real check; this budget only bounds how long the
// view may take to get there. Under Xvfb the drag settles in 2.8-4.0s (four
// measured runs: 2.772, 3.863, 3.930, and one at 4.005 that went red against
// the 4s budget this used to carry). A deadline sitting on the upper edge of
// that spread turns a passing check into a coin flip, so the budget is 3x the
// slowest settle measured.
// It cannot grow much beyond that: one run reaches this wait twice, and the
// recovery flow spends up to 8s in waitForDeckState before it gets here, all
// inside the 45s deadline runVerification races against. Overrun that deadline
// and the reported failure is a bare "verification timed out after 45s"
// instead of the samples below, losing exactly the diagnosis this check exists
// to give.
// A view that stops tracking never converges, so waiting longer cannot hide
// it; the elapsed time is logged on success so a real slowdown shows up as a
// number instead of an intermittent red.
async function waitForNativeFollow(mainWin, label, timeoutMs = 12_000, checkPosition = false) {
	const started = Date.now()
	const samples = []
	while (Date.now() - started < timeoutMs) {
		try {
			const state = await waitForDeckState(mainWin, `${label} slot`, 250)
			const { bounds } = previewBounds(mainWin)
			samples.push({ at: Date.now() - started, slot: state.slot, view: bounds })
			if (bounds && Math.abs(bounds.width - state.slot.width) <= 8
				&& (!checkPosition || (
					Math.abs(bounds.x - state.slot.x) <= 8
					&& Math.abs(bounds.y - state.slot.y) <= 8
					&& Math.abs(bounds.height - state.slot.height) <= 8
				))) {
				log(`[e2e] ${label} native follow settled in ${Date.now() - started}ms`)
				return { state, bounds }
			}
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
		`${label} native preview did not follow the slot within ${timeoutMs}ms; samples=${JSON.stringify(trail)}`,
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

// Chromium only delivers sendInputEvent gestures to a focused window, so focus
// is a real precondition for every drag below, not a cosmetic check. But asking
// for it and having it are different things: the window manager grants focus
// asynchronously, and reading document.hasFocus() once at a fixed delay fails
// whenever the grant lands late (4 red in 11 local runs, always before any drag
// ran). Poll instead, re-asking each round, and still fail hard if focus never
// arrives — an unfocused window cannot produce a meaningful drag result.
async function waitForWindowFocus(mainWin, timeoutMs = 5_000) {
	const started = Date.now()
	let snapshot = await e2eSnapshot(mainWin)
	while (!snapshot.documentFocused && Date.now() - started < timeoutMs) {
		app.focus({ steal: true })
		mainWin.focus()
		mainWin.webContents.focus()
		await sleep(100)
		snapshot = await e2eSnapshot(mainWin)
	}
	log(`[e2e] window focus ${snapshot.documentFocused ? 'acquired' : 'NOT acquired'} after ${Date.now() - started}ms`)
	return snapshot
}

// A tab drag needs the window focused for the whole gesture, not just at its
// start: Chromium drops sendInputEvent for an unfocused window, so the drag
// delivers nothing and the run fails claiming the model did not change, when
// the real story is that no pointer event ever arrived. Seen once in 8 local
// runs — the drag reported zero events and the snapshot went focused before to
// unfocused after, because another desktop app took focus mid-gesture. CI has
// no competing app and has never hit it.
// Retry exactly that combination and nothing else: zero events delivered AND
// focus lost. A dock that is genuinely broken still delivers its events, so it
// still fails on the first attempt.
async function driveTabDragFocused(mainWin, options) {
	await waitForWindowFocus(mainWin, 2_000)
	const drag = await driveTabDrag(mainWin, options)
	if (drag && drag.events.length === 0) {
		const snapshot = await e2eSnapshot(mainWin)
		if (!snapshot.documentFocused) {
			log('[e2e] tab drag delivered no events and the window had lost focus; re-focusing and retrying once')
			await waitForWindowFocus(mainWin, 2_000)
			return driveTabDrag(mainWin, options)
		}
	}
	return drag
}

// E2E mode intentionally covers only input-driven behavior. The ordinary demo
// still proves the broader tab/native/restore showcase without requiring a
// focused desktop window.
async function runE2EVerification(mainWin) {
	await rendererReady
	await sleep(900)
	const initial = await waitForWindowFocus(mainWin)
	assertE2E(initial.documentFocused, 'window focus', JSON.stringify({ window: mainWin.isFocused(), document: initial.documentFocused }))
	await captureE2EMetrics(mainWin, 'before-drag')
	await verifyPositionOnlyDrag(mainWin)

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

	// Drop output on the left edge of its sibling group. This is a real HTML DnD
	// gesture; the resulting extra split demonstrates a structural model and DOM
	// mutation rather than a visual drop indicator alone.
	const leftDrag = await driveTabDragFocused(mainWin, {
		panelId: 'output',
		targetGroupId: 'g-right',
		zone: 'left',
	})
	await sleep(500)
	const afterLeft = await e2eSnapshot(mainWin)
	assertE2E(
		!!leftDrag
			&& completedTabDrag(leftDrag, 'output')
			&& afterLeft.serialized !== afterSplit.serialized
			&& afterLeft.splitCount > afterSplit.splitCount
			&& documentContains(afterLeft.groups, 'output'),
		'tab drag to left mutates DOM and model',
		JSON.stringify({ leftDrag, before: afterSplit, after: afterLeft }),
	)

	// Then join that real tab into the left tab strip (the center-drop path).
	// Targeting Preview's visible tab avoids the native view body overlay while
	// still exercising the tab-strip's browser drag/drop handler.
	const centerDrag = await driveTabDragFocused(mainWin, {
		panelId: 'output',
		targetGroupId: 'g-left',
		targetPanelId: 'preview',
		zone: 'center',
	})
	await sleep(500)
	const afterCenter = await e2eSnapshot(mainWin)
	assertE2E(
		!!centerDrag
			&& completedTabDrag(centerDrag, 'output')
			&& afterCenter.serialized !== afterLeft.serialized
			&& afterCenter.groups['g-left']?.includes('output')
			&& documentContains(afterCenter.groups, 'output'),
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
	// Click the output tab in g-right; assert model g-right active === 'output',
	// the output body is visible, and the doc body is still mounted but
	// hidden (DockView leaves inactive panel DOM in place — see
	// panel-body.tsx — rather than removing it).
	log('── PROOF 1: DOM tab switch (g-right doc → output) ──')
	const beforeActive = await js(`window.__deck.activeOf('g-right')`)
	await js(`document.querySelector('[data-deck-tab="output"]').click()`)
	await sleep(300)
	const afterActive = await js(`window.__deck.activeOf('g-right')`)
	const outputBodyVisible = await js(
		`!!document.querySelector('[data-deck-panel-body="output"] [data-test-dom-content="output"]') && getComputedStyle(document.querySelector('[data-deck-panel-body="output"]')).display !== 'none'`,
	)
	const docBodyHidden = await js(
		`!!document.querySelector('[data-deck-panel-body="doc"]') && getComputedStyle(document.querySelector('[data-deck-panel-body="doc"]')).display === 'none'`,
	)
	const tabActive = await js(
		`document.querySelector('[data-deck-tab="output"]').getAttribute('data-active') === 'true'`,
	)
	log('PROOF1: g-right active', beforeActive, '→', afterActive, '| outputVisible', String(outputBodyVisible), '| docHidden', String(docBodyHidden), '| tabActive', String(tabActive))
	if (afterActive === 'output' && outputBodyVisible && docBodyHidden && tabActive) {
		log('✅ DOM tab switch: clicking [data-deck-tab="output"] flipped the model, showed the output body, and left the doc body mounted-but-hidden.')
	} else {
		log('❌ DOM tab switch did NOT propagate to the model/DOM.')
	}
	await shot(mainWin, '2-after-tab-switch.png')

	// ── PROOF 2: native slot following ────────────────────────────────────────
	// Resize the dock host (renderer-driven): react-resizable-panels re-distributes
	// the left (preview) panel → the native slot rect changes → the view-anchor
	// re-publishes → the framework moves the native WCV. Assert the native preview
	// block's width SHRANK to track its slot. Zero host resize code.
	log('── PROOF 2: native slot following (renderer-driven resize) ──')
	await js(`window.__deck.setHostWidth(880)`)
	await sleep(700)
	const before = previewBounds(mainWin).bounds
	log('PROOF2: native preview bounds @hostWidth=880 :', JSON.stringify(before))
	await js(`window.__deck.setHostWidth(520)`)
	await sleep(700)
	const after = previewBounds(mainWin).bounds
	log('PROOF2: native preview bounds @hostWidth=520 :', JSON.stringify(after))
	await shot(mainWin, '3-after-resize.png')

	// The left panel is ~half the dock host (rrp 50/50). Host 880→520 shrinks the
	// left region by ~180px; the native preview slot (minus CSS margins) tracks it.
	const previewDelta = before && after ? before.width - after.width : 0
	const previewTracked = previewDelta > 100 && previewDelta < 260 // ~180 expected, generous band
	log('PROOF2: native preview widthΔ =', String(previewDelta), '(expect ~180; band 100..260)')
	if (previewTracked) {
		log('✅ native slot following: the native preview WCV tracked the dock slot rect (renderer-driven geometry, zero host resize code).')
	} else {
		log('❌ native preview block did NOT follow the dock slot resize.')
	}

	if (process.env.DECK_DEMO_PROFILE === '1') {
		await captureProfiles(mainWin)
	}

	if (process.env.DECK_DEMO_LAG === '1') {
		await measureDragLag(mainWin)
	}

	// ── PROOF 3: serialize / restore ──────────────────────────────────────────
	// Move 'output' to the left group (cross-group move via the model API), then
	// serialize → teardown → parse+validate → rebuild fresh. Assert the restored
	// DOM reflects the persisted tree: g-right active was 'output' before the move;
	// after the move 'output' lives in g-left. The restored tree must preserve that
	// 'output' is in g-left and that the previously-activated state round-tripped.
	log('── PROOF 3: serialize / restore ──')
	// First restore the preview slot to a sane width so re-mount re-anchors.
	await js(`window.__deck.setHostWidth(900)`)
	await sleep(200)
	// move output into the left group (so the persisted tree differs from default).
	await js(`window.__deck.moveOutputLeft()`)
	await sleep(200)
	const preOutputInLeft = await js(
		`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="output"]')`,
	)
	const persistedJson = await js(`window.__deck.serializeLayout(window.__deck.model().get())`)
	log('PROOF3: pre-restore — output tab in g-left:', String(preOutputInLeft))
	log('PROOF3: serialized tree:', persistedJson)

	const restore = await js(`window.__deck.serializeRestore()`)
	if (!restore.ok) {
		log('PROOF3: parseLayout/collectTreeProblems FAILED:', JSON.stringify(restore.problems))
		log('❌ serialize/restore: validation rejected the persisted tree.')
	} else {
		await sleep(400)
		const postOutputInLeft = await js(
			`!!document.querySelector('[data-deck-group="g-left"] [data-deck-tab="output"]')`,
		)
		const postPreviewSlot = await js(
			`!!document.querySelector('[data-deck-native-slot="preview"]')`,
		)
		log('PROOF3: post-restore — output tab in g-left:', String(postOutputInLeft), '| native slot present:', String(postPreviewSlot))
		if (postOutputInLeft && postPreviewSlot) {
			log('✅ serialize/restore: persisted tree round-tripped through serializeLayout→parseLayout→collectTreeProblems and the rebuilt DockView reflects it (output in g-left, native slot intact).')
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
