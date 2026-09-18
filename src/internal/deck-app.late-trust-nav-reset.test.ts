import { describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
import type { Runtime, ViewPlacement } from '../types.js'
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

/**
 * Navigation-driven slot-token revocation on the LATE-TRUST path.
 *
 * A window built via `runtime.windows.create({ autoTrust: false })` and trusted
 * LATER via `runtime.windows.trust(win)` must bind the `did-start-navigation`
 * slot-reset hook — otherwise only auto-trusted windows get it bound in
 * `constructWindow`. So the late-trusted window's control wc could perform a
 * MAIN-FRAME CROSS-DOCUMENT navigation and the navigated-to document would
 * INHERIT the prior page's anchored-placement slot tokens (privilege
 * escalation over the placement surface).
 *
 * `bindNavigationSlotReset(wc)` is bound in the `windows.trust()` tracked
 * branch too (idempotently, guarded by `navHookBound`).
 *
 * CONTRACT pinned here (mirrors the auto-trust contract in
 * deck-app.navigation-slot-reset.test.ts, but exercised through the LATE-TRUST
 * path — `create({autoTrust:false})` + `windows.trust()`):
 *   • main-frame CROSS-DOCUMENT (isMainFrame=true, isInPlace=false) → REVOKE.
 *   • in-place (hash/pushState, isInPlace=true)                     → NO revoke.
 *   • trusting twice (idempotency) → a single nav revokes exactly once,
 *     no double-bind / no throw.
 *
 * The fakes are copied verbatim from deck-app.navigation-slot-reset.test.ts so
 * that every constructed window's control wc is an EventEmitter-ish object that
 * registers + emits 'did-start-navigation' (and thus the CREATED window's wc
 * supports `_emitNav`, not just the main window's).
 */

// ── Fakes (verbatim from deck-app.navigation-slot-reset.test.ts) ──────────────

type InvokeHandler = (
	event: { sender: { id: number } },
	...args: unknown[]
) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: ReturnType<typeof vi.fn> & MinimalIpcMain['handle']
	removeHandler: ReturnType<typeof vi.fn> & MinimalIpcMain['removeHandler']
	handlers: Map<string, InvokeHandler>
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, InvokeHandler>()
	const handle = vi.fn((channel: string, handler: InvokeHandler) => {
		handlers.set(channel, handler)
	}) as FakeIpcMain['handle']
	const removeHandler = vi.fn((channel: string) => {
		handlers.delete(channel)
	}) as FakeIpcMain['removeHandler']
	return { handle, removeHandler, handlers }
}

/**
 * Electron `did-start-navigation` listener signature (subset we drive):
 *   (event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId)
 */
type NavListener = (
	event: { preventDefault(): void },
	url: string,
	isInPlace: boolean,
	isMainFrame: boolean,
	...rest: unknown[]
) => void

/** A webContents fake that is an EventEmitter for navigation events. */
interface NavFakeWebContents extends MinimalWebContentsLike {
	loadURL: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadURL']
	loadFile: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadFile']
	send: ReturnType<typeof vi.fn> & MinimalWebContentsLike['send']
	destroyed: boolean
	/** Real Electron webContents is an EventEmitter — the nav hook attaches here. */
	on: ReturnType<typeof vi.fn>
	/** Test-only: registered listeners keyed by event name. */
	_navListeners: Map<string, NavListener[]>
	/** Test-only: fire 'did-start-navigation' with the given (in/cross, frame) shape. */
	_emitNav(opts: { url?: string; isInPlace: boolean; isMainFrame: boolean }): void
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: NavFakeWebContents
	getContentBounds: ReturnType<typeof vi.fn> & MinimalBrowserWindow['getContentBounds']
	show: ReturnType<typeof vi.fn> & MinimalBrowserWindow['show']
	destroy: ReturnType<typeof vi.fn> & MinimalBrowserWindow['destroy']
	on: ReturnType<typeof vi.fn> & MinimalBrowserWindow['on']
	contentView: MinimalBrowserWindow['contentView'] & {
		addChildView: ReturnType<typeof vi.fn>
		removeChildView: ReturnType<typeof vi.fn>
	}
	destroyed: boolean
	_listeners: Map<string, Array<(...args: unknown[]) => void>>
	_emit(event: 'resize' | 'closed' | 'close'): void
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: NavFakeWebContents
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
}

interface FakeElectron extends MinimalElectron {
	browserWindows: FakeBrowserWindow[]
	webContentsViews: FakeWebContentsView[]
	browserWindowCtorCalls: MinimalBrowserWindowOptions[]
	webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined>
}

function createFakeElectron(
	initialContentBounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeElectron {
	let wcIdCounter = 100
	let winIdCounter = 1
	const browserWindows: FakeBrowserWindow[] = []
	const webContentsViews: FakeWebContentsView[] = []
	const browserWindowCtorCalls: MinimalBrowserWindowOptions[] = []
	const webContentsViewCtorCalls: Array<{ webPreferences?: { preload?: string } } | undefined> = []

	function makeFakeWebContents(): NavFakeWebContents {
		const id = wcIdCounter++
		const navListeners = new Map<string, NavListener[]>()
		const wc: NavFakeWebContents = {
			id,
			destroyed: false,
			loadURL: vi.fn(async (_u: string) => undefined) as NavFakeWebContents['loadURL'],
			loadFile: vi.fn(async (_p: string) => undefined) as NavFakeWebContents['loadFile'],
			send: vi.fn() as NavFakeWebContents['send'],
			isDestroyed: () => wc.destroyed,
			_navListeners: navListeners,
			on: vi.fn((event: string, listener: NavListener) => {
				let arr = navListeners.get(event)
				if (!arr) {
					arr = []
					navListeners.set(event, arr)
				}
				arr.push(listener)
				return wc
			}),
			_emitNav: ({ url = 'http://localhost/next', isInPlace, isMainFrame }) => {
				const arr = navListeners.get('did-start-navigation')
				if (!arr) return
				const ev = { preventDefault: vi.fn() }
				for (const fn of arr) fn(ev, url, isInPlace, isMainFrame, 1, 1)
			},
		}
		return wc
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: NavFakeWebContents
		readonly contentView: FakeBrowserWindow['contentView']
		destroyed: boolean
		getContentBounds: FakeBrowserWindow['getContentBounds']
		show: FakeBrowserWindow['show']
		destroy: FakeBrowserWindow['destroy']
		on: FakeBrowserWindow['on']
		_listeners: Map<string, Array<(...args: unknown[]) => void>>

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push(opts ?? {})
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			const cv = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			}
			this.contentView = cv as FakeBrowserWindow['contentView']
			this.getContentBounds = vi.fn(
				() => initialContentBounds,
			) as FakeBrowserWindow['getContentBounds']
			this.show = vi.fn() as FakeBrowserWindow['show']
			this.destroy = vi.fn(() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this._listeners = new Map()
			this.on = vi.fn(
				(event: 'resize' | 'closed' | 'close', listener: (...args: unknown[]) => void) => {
					let arr = this._listeners.get(event)
					if (!arr) {
						arr = []
						this._listeners.set(event, arr)
					}
					arr.push(listener)
					return this
				},
			) as FakeBrowserWindow['on']
			browserWindows.push(this as unknown as FakeBrowserWindow)
		}

		_emit(event: 'resize' | 'closed' | 'close'): void {
			const arr = this._listeners.get(event)
			if (!arr) return
			if (event === 'close') {
				const ev = { preventDefault: vi.fn() }
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
		readonly webContents: NavFakeWebContents
		setBounds: FakeWebContentsView['setBounds']

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
			webContentsViews.push(this as unknown as FakeWebContentsView)
		}
	}

	return {
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		browserWindows,
		webContentsViews,
		browserWindowCtorCalls,
		webContentsViewCtorCalls,
	}
}

// ── Slot-token helpers (mirror deck-app.navigation-slot-reset.test.ts) ────────

interface ViewSource {
	url?: string
	file?: string
}
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number; anchor?: string }): HostViewHandle
	applyPlacement(p: ViewPlacement): HostViewHandle
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource; scope?: unknown }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

// The slot-grant payload the framework pushes to the authorized wc.
interface SlotGrant {
	viewId: string
	slotId: string
	slotToken: string
	generation: number
}

function lastWcv(electron: FakeElectron): FakeWebContentsView {
	const wcv = electron.webContentsViews[electron.webContentsViews.length - 1]
	if (!wcv) throw new Error('no WebContentsView was constructed')
	return wcv
}

// Pull the most recent slot-grant the framework sent to `wc`.
function lastSlotGrant(wc: NavFakeWebContents): SlotGrant {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const [channel, payload] = calls[i] as [string, unknown]
		if (channel === DeckChannel.SlotGrant) return payload as SlotGrant
	}
	throw new Error(`no slot-grant was sent to wc#${wc.id}`)
}

// Frame-aware event shape so the snapshot handler's main-frame gate sees a
// real main frame.
type FrameRef = { routingId: number; processId: number } | null
interface FrameEvent {
	sender: { id: number; mainFrame?: FrameRef }
	senderFrame?: FrameRef
}
function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

// Build a raw snapshot payload. generation + epoch must be provided explicitly
// so callers can control epoch ordering across consecutive sends.
function buildSnapshot(
	views: Array<{ slotToken: string; placement: object }>,
	generation: number,
	epoch: number,
) {
	return {
		generation,
		epoch,
		views: views.map((v) => ({ placement: v.placement, extra: { slotToken: v.slotToken } })),
	}
}

function getSnapshotHandler(ipcMain: FakeIpcMain): InvokeHandler {
	const h = ipcMain.handlers.get(DeckChannel.Snapshot)
	if (!h) throw new Error(`"${DeckChannel.Snapshot}" handler not registered`)
	return h
}

/**
 * The DeckWindow handle `runtime.windows.create` returns: `.window` is the raw
 * BrowserWindow (what `windows.trust(win)` expects and what `placeIn` binds the
 * slot token's authorized wc to), `.window.webContents` is the new window's
 * CONTROL wc (a NavFakeWebContents that supports `_emitNav`).
 */
interface CreatedDeckWindow {
	window: { webContents: NavFakeWebContents }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeckApp — LATE-TRUST: create({autoTrust:false}) + windows.trust() binds the nav slot-reset hook', () => {
	// POSITIVE regression: the bug was that a LATE-trusted window's control wc
	// never got the did-start-navigation hook (only auto-trusted windows did). So
	// mint a slot token by placeIn-anchoring a view into the late-trusted window,
	// confirm an authorized snapshot drives setBounds, perform a MAIN-FRAME
	// CROSS-DOCUMENT navigation, and assert the SAME token is now rejected — the
	// navigated-to document must NOT inherit the prior page's anchored placement.
	it('main-frame cross-document nav on a LATE-trusted window revokes its slot token → stale snapshot is rejected', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		// LATE-TRUST PATH: build untrusted, then trust via windows.trust().
		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents

		// Sanity: while untrusted, the nav hook is NOT yet bound (autoTrust:false
		// path skips bindNavigationSlotReset in constructWindow).
		expect(wc.on).not.toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

		// Trust it late — the FIX must bind the nav hook here.
		app.runtime.windows.trust(
			deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0],
		)

		// The fix wired the nav hook onto the late-trusted control wc.
		expect(wc.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(deckWin, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(wc)

		const snapshotHandler = getSnapshotHandler(ipcMain)

		// Sanity: while the token is live, an authorized snapshot drives setBounds.
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } },
					},
				],
				grant.generation,
				0,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalledTimes(1)

		// Cross-document main-frame navigation — the navigated-to document must
		// NOT inherit the prior page's anchored-placement authorization.
		wc._emitNav({ url: 'http://localhost/evil', isInPlace: false, isMainFrame: true })

		const boundsBefore = wcv.setBounds.mock.calls.length
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 999, y: 999, width: 1, height: 1 } },
					},
				],
				grant.generation,
				1,
			),
		)
		expect(wcv.setBounds.mock.calls.length).toBe(boundsBefore)

		await app.shutdown()
	})

	// NEGATIVE: an in-place navigation (hash change / history.pushState) is the
	// SAME document — even on the late-trusted window it must NOT revoke.
	it('in-place navigation on a LATE-trusted window does NOT revoke its slot token', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents
		app.runtime.windows.trust(
			deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0],
		)

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(deckWin, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(wc)

		// hash/pushState — same document, must NOT revoke.
		wc._emitNav({ url: 'http://localhost/page#section', isInPlace: true, isMainFrame: true })

		const snapshotHandler = getSnapshotHandler(ipcMain)
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } },
					},
				],
				grant.generation,
				0,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 })

		await app.shutdown()
	})

	// IDEMPOTENCY: if the late-trusted window is trusted TWICE, the nav hook must
	// be bound at most ONCE (navHookBound guard). A single main-frame cross-doc
	// nav must therefore revoke EXACTLY ONCE — no throw, no double-bind, token gone.
	it('trusting a window twice does not double-bind the nav hook — a single nav revokes exactly once', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const deckWin = app.runtime.windows.create({
			source: { url: 'http://localhost:5173/untrusted.html' },
			autoTrust: false,
		}) as unknown as CreatedDeckWindow
		const wc = deckWin.window.webContents

		// Trust TWICE — the second trust must NOT register a second nav listener.
		const rawWin = deckWin.window as unknown as Parameters<Runtime['windows']['trust']>[0]
		app.runtime.windows.trust(rawWin)
		app.runtime.windows.trust(rawWin)

		// Exactly one 'did-start-navigation' listener bound, despite two trusts.
		const navRegistrations = wc.on.mock.calls.filter(
			(c: unknown[]) => c[0] === 'did-start-navigation',
		)
		expect(navRegistrations).toHaveLength(1)
		expect(wc._navListeners.get('did-start-navigation') ?? []).toHaveLength(1)

		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(deckWin, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(wc)

		const snapshotHandler = getSnapshotHandler(ipcMain)
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } },
					},
				],
				grant.generation,
				0,
			),
		)
		expect(wcv.setBounds).toHaveBeenCalledTimes(1)

		// A SINGLE main-frame cross-doc nav: must revoke cleanly (no throw / no
		// double-revoke error) and leave the token gone.
		expect(() =>
			wc._emitNav({ url: 'http://localhost/evil', isInPlace: false, isMainFrame: true }),
		).not.toThrow()

		const boundsBefore = wcv.setBounds.mock.calls.length
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 999, y: 999, width: 1, height: 1 } },
					},
				],
				grant.generation,
				1,
			),
		)
		expect(wcv.setBounds.mock.calls.length).toBe(boundsBefore)

		await app.shutdown()
	})
})
