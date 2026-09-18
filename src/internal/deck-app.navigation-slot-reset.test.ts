import { describe, expect, it, vi } from 'vitest'
import { DeckChannel } from '../shared/protocol.js'
import type { JsonValue, Runtime, ViewPlacement } from '../types.js'
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
 * Navigation-driven slot-token revocation.
 *
 * CONTRACT (deck-app.ts `bindNavigationSlotReset`): a control wc that has an
 * anchored `placeIn` slot token loses that token when it performs a MAIN-FRAME
 * CROSS-DOCUMENT navigation — so the navigated-to document cannot inherit the
 * prior page's anchored-placement authorization (privilege-inheritance hole).
 * Trust itself is LEFT INTACT (no `wcScope` teardown) — only the slot tokens
 * bound to that wc are revoked, synchronously.
 *
 *   • main-frame CROSS-DOCUMENT (isMainFrame=true, isInPlace=false) → REVOKE.
 *   • in-place (hash/pushState, isInPlace=true)                     → NO revoke.
 *   • sub-frame (isMainFrame=false)                                 → NO revoke.
 *
 * Fakes mirror deck-app.slot-token.test.ts, EXTENDED so the control wc is an
 * EventEmitter-ish object that can register + emit 'did-start-navigation'
 * listeners (the real Electron `webContents` is an EventEmitter; the Minimal
 * fake had no `.on`).
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

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

// ── Slot-token helpers (mirror deck-app.slot-token.test.ts) ─────────────────

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

type InvokeOk = { ok: true; result: JsonValue }
type InvokeFail = { ok: false; error: { code?: string; message?: string; remoteName?: string } }

async function invokeHost(
	ipcMain: FakeIpcMain,
	senderId: number,
	name: string,
	args: JsonValue[] = [],
): Promise<InvokeOk | InvokeFail> {
	const invoke = ipcMain.handlers.get(DeckChannel.Invoke)
	if (!invoke) throw new Error('invoke handler missing')
	return (await invoke({ sender: { id: senderId } }, { kind: 'host', name, args })) as
		| InvokeOk
		| InvokeFail
}

/** The auto-trusted main window's webContents — the trusted CONTROL wc. */
function mainWc(electron: FakeElectron): NavFakeWebContents {
	return (electron.browserWindows[0] as unknown as FakeBrowserWindow).webContents
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeckApp — main-frame cross-document navigation revokes the control wc slot tokens', () => {
	// POSITIVE: mint a slot token via an anchored placeIn, confirm an authorized
	// snapshot drives setBounds, then perform a MAIN-FRAME CROSS-DOCUMENT
	// navigation on the control wc; the SAME token must now be rejected — the
	// navigated-to page can't inherit the prior page's anchored placement.
	it('main-frame cross-document nav (isMainFrame=true, isInPlace=false) revokes the slot token → stale snapshot is rejected', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
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

		// Sanity: the framework wired the nav hook onto the control wc (so the
		// revocation is even reachable). If this fails, the hook is entirely absent.
		expect(wc.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function))

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

	// NEGATIVE: in-place navigation (hash change / history.pushState) is the SAME
	// document — it must NOT revoke. The token survives, the snapshot stays
	// authorized.
	it('in-place navigation (isMainFrame=true, isInPlace=true) does NOT revoke the slot token', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
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

	// NEGATIVE: a sub-frame (iframe) navigation must NOT revoke the top-level
	// control wc's slot tokens — only a MAIN-FRAME navigation is a document swap
	// for the anchored-placement surface.
	it('sub-frame navigation (isMainFrame=false) does NOT revoke the slot token', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		const wc = mainWc(electron)
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(wc)

		// A subframe cross-document navigation — must NOT revoke the top-level token.
		wc._emitNav({ url: 'http://ads.example/frame', isInPlace: false, isMainFrame: false })

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

	// TRUST: after a main-frame cross-document nav, only the slot tokens are
	// revoked — the wc stays TRUSTED/usable. An ORDINARY (un-gated) hostServices
	// call must still succeed for the same sender.
	it('after main-frame cross-doc nav the wc stays trusted (ordinary hostServices.ping still ok) — only the slot token is gone', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app = new DeckApp(
			{ hostServices: { ping: () => 'pong' as JsonValue } },
			{ electron, wireTransport: { ipcMain } },
		)
		await app.start()

		const wc = mainWc(electron)
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#sim' })
		const grant = lastSlotGrant(wc)

		wc._emitNav({ url: 'http://localhost/next', isInPlace: false, isMainFrame: true })

		// The slot token is gone …
		const snapshotHandler = getSnapshotHandler(ipcMain)
		await snapshotHandler(
			mainFrameEvent(wc.id),
			buildSnapshot(
				[
					{
						slotToken: grant.slotToken,
						placement: { visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } },
					},
				],
				grant.generation,
				0,
			),
		)
		expect(wcv.setBounds).not.toHaveBeenCalled()

		// … but the wc is still TRUSTED — ordinary (un-gated) calls succeed.
		const ordinary = await invokeHost(ipcMain, wc.id, 'ping', [])
		expect(ordinary.ok).toBe(true)
		expect((ordinary as InvokeOk).result).toBe('pong')

		await app.shutdown()
	})
})
