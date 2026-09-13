/**
 * Memory regression gate for repeated window/view churn. The listener-set and
 * map cleanups this guards (Scope/Connection close dropping their listener
 * sets, `DeckApp.shutdown()` clearing its tracking maps — see
 * `src/internal/deck-app.ts` around the shutdown teardown) previously had
 * only a one-off manual measurement backing them; this file makes that a
 * repeatable, automated gate. Two complementary assertions:
 *
 *  1. RECLAIMABILITY (deterministic) — every fake object a closed
 *     window/view cycle produced (the window, and each placed view's
 *     `webContents` and handle) is reachable ONLY through a `WeakRef` once
 *     the test drops its own strong references — i.e. nothing inside
 *     `DeckApp` is still pinning it.
 *  2. HEAP GROWTH (threshold) — running many more such cycles after a
 *     warm-up does not grow `process.memoryUsage().heapUsed` by more than a
 *     small bound (steady-state churn must not accumulate).
 *
 * Forcing a real GC pass: `v8.setFlagsFromString('--expose_gc')` +
 * `vm.runInNewContext('gc')` exposes a `gc()` callable from a fresh context
 * (kept off the global object). Verified directly in a plain `node -e`
 * process before writing this file; the first `it` below re-verifies it
 * inside vitest itself (v4's default pool is `forks` — one child process per
 * test file — so the flag applies to a real, single-purpose process, not a
 * shared worker thread).
 *
 * NOTE on the fake electron harness: unlike `deck-app.keepalive.test.ts`
 * (which keeps every fake `BrowserWindow`/`WebContentsView` it ever
 * constructs in `browserWindows`/`webContentsViews` — fine for that suite's
 * small, fixed fake count per test), a harness doing hundreds of
 * create/close cycles cannot do that: those arrays would themselves pin
 * every "closed" fake forever, making reclaimability unobservable through no
 * fault of `DeckApp`. So the fakes below are pruned from those tracking
 * arrays once a window's `'closed'` cascade has run — mirroring a real
 * Electron, which does not keep destroyed windows/views alive either.
 */
import { describe, expect, it } from 'vitest'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { Runtime } from '../types.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './electron-types.js'
import { DeckApp } from './deck-app.js'
import type { MinimalIpcMain } from './wire-transport.js'

// ── Forced GC ────────────────────────────────────────────────────────────
v8.setFlagsFromString('--expose_gc')
const forceGc = vm.runInNewContext('gc') as () => void

async function settleMacrotask(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

// Several passes: one GC pass can leave finalization/microtask-scheduled drops
// for the next pass to pick up, so a single call under-reports reclaimed
// memory and under-clears WeakRefs.
async function forceGcRepeatedly(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		forceGc()
		await settleMacrotask()
	}
}

// ── Minimal fakes (trimmed from deck-app.keepalive.test.ts's harness) ──────

type InvokeHandler = (
	event: { sender: { id: number } },
	...args: unknown[]
) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: MinimalIpcMain['handle']
	removeHandler: MinimalIpcMain['removeHandler']
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, InvokeHandler>()
	return {
		handle: ((channel: string, handler: InvokeHandler) => {
			handlers.set(channel, handler)
		}) as FakeIpcMain['handle'],
		removeHandler: ((channel: string) => {
			handlers.delete(channel)
		}) as FakeIpcMain['removeHandler'],
	}
}

interface FakeWebContentsLike extends MinimalWebContentsLike {
	loadURL: MinimalWebContentsLike['loadURL']
	loadFile: MinimalWebContentsLike['loadFile']
	send: MinimalWebContentsLike['send']
	close: () => void
	destroyed: boolean
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: FakeWebContentsLike
	getContentBounds: MinimalBrowserWindow['getContentBounds']
	show: MinimalBrowserWindow['show']
	destroy: MinimalBrowserWindow['destroy']
	on: MinimalBrowserWindow['on']
	contentView: MinimalBrowserWindow['contentView'] & {
		addChildView: (view: unknown) => void
		removeChildView: (view: unknown) => void
	}
	destroyed: boolean
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: MinimalWebContentsView['setBounds']
	destroyed: boolean
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []

	function makeFakeWebContents(): FakeWebContentsLike {
		const id = wcIdCounter++
		const wc: FakeWebContentsLike = {
			id,
			destroyed: false,
			loadURL: (async (_u: string) => undefined) as FakeWebContentsLike['loadURL'],
			loadFile: (async (_p: string) => undefined) as FakeWebContentsLike['loadFile'],
			send: (() => undefined) as FakeWebContentsLike['send'],
			close: () => {
				wc.destroyed = true
			},
			isDestroyed: () => wc.destroyed,
		}
		return wc
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: FakeWebContentsLike
		readonly contentView: FakeBrowserWindow['contentView']
		destroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>

		constructor(_opts?: MinimalBrowserWindowOptions) {
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			this.contentView = {
				addChildView: () => undefined,
				removeChildView: () => undefined,
			} as FakeBrowserWindow['contentView']
			this.getContentBounds = (() => initialContentBounds) as FakeBrowserWindow['getContentBounds']
			this.show = (() => undefined) as FakeBrowserWindow['show']
			this.destroy = (() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this._listeners = new Map()
			this.on = ((event: 'resize' | 'closed' | 'close', listener: (...args: unknown[]) => void) => {
				let arr = this._listeners.get(event)
				if (!arr) {
					arr = []
					this._listeners.set(event, arr)
				}
				arr.push(listener)
				return this
			}) as FakeBrowserWindow['on']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: () => undefined }
				for (const fn of arr) fn(ev)
				return
			}
			for (const fn of arr) fn()
		}

		isDestroyed(): boolean {
			return this.destroyed
		}
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: FakeWebContentsLike
		setBounds: FakeWebContentsView['setBounds']
		destroyed: boolean

		constructor(_opts?: { webPreferences?: { preload?: string } }) {
			this.webContents = makeFakeWebContents()
			this.setBounds = (() => undefined) as FakeWebContentsView['setBounds']
			this.destroyed = false
			webContentsViews.push(this as unknown as FakeWebContentsView)
		}
	}

	return {
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		webContentsViews,
	}
}

// The WCV the handle owns is the LAST WebContentsView the fake electron
// constructed during the `runtime.view(...)` call (no toolbar in these tests).
function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// Drop the harness's own retention of a closed window/view (see file doc
// comment) — a real Electron does not keep destroyed natives alive either,
// so leaving them in these arrays would make DeckApp's OWN cleanup
// unobservable behind the fake's bookkeeping.
function pruneWindow(electron: FakeElectron, win: FakeBrowserWindow): void {
	const idx = electron.browserWindows.indexOf(win)
	if (idx >= 0) electron.browserWindows.splice(idx, 1)
}
function pruneView(electron: FakeElectron, wcv: FakeWebContentsView): void {
	const idx = electron.webContentsViews.indexOf(wcv)
	if (idx >= 0) electron.webContentsViews.splice(idx, 1)
}

const VIEWS_PER_WINDOW = 3

interface CycleRefs {
	winRef: WeakRef<object>
	viewRefs: Array<{ wcRef: WeakRef<object>, handleRef: WeakRef<object> }>
}

// One churn cycle: create a window, place VIEWS_PER_WINDOW views into it,
// close the window (cascading disposal of its placed views, per the
// windowScope contract exercised in deck-app.keepalive.test.ts #2), then
// prune the harness's own retention. Returns only WeakRefs — no strong
// reference to any fake created here survives the call.
async function runWindowLifecycleCycle(app: DeckApp, electron: FakeElectron): Promise<CycleRefs> {
	const runtime: Runtime = app.runtime
	const win = runtime.windows.create({ source: { url: 'http://localhost:5173/popout.html' } }).window
	const fakeWin = win as unknown as FakeBrowserWindow

	const viewRefs: CycleRefs['viewRefs'] = []
	for (let zone = 0; zone < VIEWS_PER_WINDOW; zone++) {
		const handle = runtime.view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(win, { zone })
		viewRefs.push({ wcRef: new WeakRef(handle.webContents), handleRef: new WeakRef(handle) })
		pruneView(electron, wcv)
	}

	const winRef = new WeakRef(fakeWin)

	fakeWin._emit('closed')
	await settleMacrotask()
	pruneWindow(electron, fakeWin)

	return { winRef, viewRefs }
}

describe('DeckApp memory regression — repeated window/view churn is fully reclaimable and does not grow the heap', () => {
	it('the forced-GC harness exposes a callable gc() usable from within a vitest worker', () => {
		expect(typeof forceGc).toBe('function')
		expect(() => forceGc()).not.toThrow()
	})

	it('closing N windows (each hosting 3 placed views) leaves every window, view handle, and webContents collectible', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		const CYCLES = 20
		const refs: WeakRef<object>[] = []
		for (let i = 0; i < CYCLES; i++) {
			const { winRef, viewRefs } = await runWindowLifecycleCycle(app, electron)
			refs.push(winRef, ...viewRefs.map(v => v.wcRef), ...viewRefs.map(v => v.handleRef))
			// `runWindowLifecycleCycle`'s own locals (win, handle, wcv) are out of
			// scope here — `refs` holds nothing but WeakRefs.
		}

		// Asserted while the app is still running: a closed window must be
		// reclaimable without waiting for shutdown() to clear app-level maps.
		await forceGcRepeatedly()

		const stillAlive = refs.filter(r => r.deref() !== undefined)
		expect(stillAlive.length).toBe(0)
		await app.shutdown()
	})

	it('30 churn cycles after a 5-cycle warm-up do not grow heapUsed by more than 1MB', async () => {
		const electron = createFakeElectron()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain: createFakeIpcMain() } })
		await app.start()

		// Warm-up: let one-time costs (lazy module state, first-time Map bucket
		// growth, JIT warm-up) settle so the measured delta below reflects
		// steady-state churn, not startup noise.
		for (let i = 0; i < 5; i++) await runWindowLifecycleCycle(app, electron)
		await forceGcRepeatedly()
		const baselineHeapUsed = process.memoryUsage().heapUsed

		for (let i = 0; i < 30; i++) await runWindowLifecycleCycle(app, electron)
		await forceGcRepeatedly()
		const afterChurnHeapUsed = process.memoryUsage().heapUsed

		await app.shutdown()

		const growthBytes = afterChurnHeapUsed - baselineHeapUsed
		expect(growthBytes).toBeLessThan(1 * 1024 * 1024)
	})
})
