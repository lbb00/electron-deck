/**
 * Contract tests pinning two related bugs in the placement-frame path:
 *
 *   1. `applyPlacementInternal` (deck-app.ts) called `inner.applyPlacement(p)`
 *      unconditionally and then ALWAYS ran the keepAlive LRU bookkeeping — even
 *      when the inner sink itself dropped the frame (mid-`moveTo` migration, or
 *      already-disposed). A dropped frame must never mutate the LRU group: it
 *      neither marks the view evictable nor resurrects a disposed view into a
 *      live group's `hidden` list.
 *   2. The host handle's `dispose()` revoked the slot token from `this.slotTokens`
 *      but never cleared the closure's own `slotToken` variable, so a late
 *      public `applyPlacement()` on an anchor-placed, already-disposed handle
 *      still hit the anchor-placed guard and threw instead of silently
 *      dropping the frame like every other post-dispose call does.
 *
 * Fakes are copied (minimal) from deck-app.move.test.ts (moveTo + slot-token
 * plumbing) and deck-app.keepalive.test.ts (the `keepAlive` option).
 */
import { describe, expect, it, vi } from 'vitest'
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

const SNAPSHOT_CHANNEL = '__electron-deck:snapshot'
const SLOT_GRANT_CHANNEL = '__electron-deck:slot-grant'
const LAYOUT_SUBSCRIBE_CHANNEL = '__electron-deck:layout-subscribe'

// ── Minimal fakes (copied from deck-app.move.test.ts) ────────────────────────

type FrameRef = { routingId: number; processId: number } | null
interface FrameEvent {
	sender: { id: number; mainFrame?: FrameRef }
	senderFrame?: FrameRef
}
type Handler = (event: FrameEvent, ...args: unknown[]) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: ReturnType<typeof vi.fn> & MinimalIpcMain['handle']
	removeHandler: ReturnType<typeof vi.fn> & MinimalIpcMain['removeHandler']
	handlers: Map<string, Handler>
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, Handler>()
	const handle = vi.fn((channel: string, handler: Handler) => {
		handlers.set(channel, handler)
	}) as FakeIpcMain['handle']
	const removeHandler = vi.fn((channel: string) => {
		handlers.delete(channel)
	}) as FakeIpcMain['removeHandler']
	return { handle, removeHandler, handlers }
}

interface FakeWebContentsLike extends MinimalWebContentsLike {
	loadURL: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadURL']
	loadFile: ReturnType<typeof vi.fn> & MinimalWebContentsLike['loadFile']
	send: ReturnType<typeof vi.fn> & MinimalWebContentsLike['send']
	close: ReturnType<typeof vi.fn>
	destroyed: boolean
}

interface FakeBrowserWindow extends MinimalBrowserWindow {
	readonly webContents: FakeWebContentsLike
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
	_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null
}

interface FakeWebContentsView extends MinimalWebContentsView {
	readonly webContents: FakeWebContentsLike
	setBounds: ReturnType<typeof vi.fn> & MinimalWebContentsView['setBounds']
	destroyed: boolean
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

	function makeFakeWebContents(): FakeWebContentsLike {
		const id = wcIdCounter++
		const wc: FakeWebContentsLike = {
			id,
			destroyed: false,
			loadURL: vi.fn(async (_u: string) => undefined) as FakeWebContentsLike['loadURL'],
			loadFile: vi.fn(async (_p: string) => undefined) as FakeWebContentsLike['loadFile'],
			send: vi.fn() as FakeWebContentsLike['send'],
			close: vi.fn(() => {
				wc.destroyed = true
			}),
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
		_lastCloseEvent: { preventDefault: ReturnType<typeof vi.fn> } | null

		constructor(opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCalls.push(opts ?? {})
			this.id = winIdCounter++
			this.webContents = makeFakeWebContents()
			this.destroyed = false
			const cv = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			}
			this.contentView = cv as unknown as FakeBrowserWindow['contentView']
			this.getContentBounds = vi.fn(
				() => initialContentBounds,
			) as FakeBrowserWindow['getContentBounds']
			this.show = vi.fn() as FakeBrowserWindow['show']
			this.destroy = vi.fn(() => {
				this.destroyed = true
				this.webContents.destroyed = true
			}) as FakeBrowserWindow['destroy']
			this._listeners = new Map()
			this._lastCloseEvent = null
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
				this._lastCloseEvent = ev
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

		constructor(opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCalls.push(opts)
			this.webContents = makeFakeWebContents()
			this.setBounds = vi.fn() as FakeWebContentsView['setBounds']
			this.destroyed = false
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

// ── Typed escape hatch: `moveTo` + `keepAlive` on the host handle ────────────
interface ViewSource {
	url?: string
	file?: string
}
interface KeepAliveSpec {
	policy: 'lru'
	max: number
	group: string
}
interface HostViewHandle {
	placeIn(win: unknown, opts: { zone?: number; anchor?: string }): HostViewHandle
	applyPlacement(p: ViewPlacement): HostViewHandle
	moveTo(win: unknown, opts: { zone?: number; anchor?: string; rehome?: boolean }): Promise<void>
	dispose(): Promise<void>
}
interface RuntimeWithView {
	view(spec: { source: ViewSource; scope?: unknown; keepAlive?: KeepAliveSpec }): HostViewHandle
}
function withView(runtime: Runtime): RuntimeWithView {
	return runtime as unknown as RuntimeWithView
}

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

function lastSlotGrant(wc: FakeWebContentsLike): SlotGrant | null {
	const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const [channel, payload] = calls[i] as [string, unknown]
		if (channel === SLOT_GRANT_CHANNEL) return payload as SlotGrant
	}
	return null
}

function getSnapshotHandler(ipcMain: FakeIpcMain): Handler {
	const h = ipcMain.handlers.get(SNAPSHOT_CHANNEL)
	if (!h) throw new Error(`"${SNAPSHOT_CHANNEL}" handler not registered`)
	return h
}

function sendSnapshot(
	handler: Handler,
	event: FrameEvent,
	views: Array<{ slotToken: string; placement: unknown; generation: number }>,
	epoch: number,
): unknown {
	const generation = views[0]?.generation ?? 0
	return handler(event, {
		generation,
		epoch,
		views: views.map((v, i) => ({
			viewId: `v${i}`,
			placement: v.placement,
			layer: 0,
			extra: { slotToken: v.slotToken },
		})),
	})
}

function mainFrameEvent(senderId: number): FrameEvent {
	const frame: FrameRef = { routingId: 1, processId: 1000 + senderId }
	return { sender: { id: senderId, mainFrame: frame }, senderFrame: frame }
}

const HIDDEN: ViewPlacement = { visible: false }
const VISIBLE = (b: { x: number; y: number; width: number; height: number }): ViewPlacement => ({
	visible: true,
	bounds: b,
})

async function bootTwoWindows(): Promise<{
	app: DeckApp
	electron: FakeElectron
	ipcMain: FakeIpcMain
	winA: FakeBrowserWindow
	winB: FakeBrowserWindow
}> {
	const electron = createFakeElectron()
	const ipcMain = createFakeIpcMain()
	const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
	await app.start()
	const winA = electron.browserWindows[0] as unknown as FakeBrowserWindow
	const winB = app.runtime.windows.create({
		source: { url: 'http://localhost:5173/winB.html' },
	}).window as unknown as FakeBrowserWindow
	return { app, electron, ipcMain, winA, winB }
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) A frame the inner sink DROPS (mid-moveTo) must not touch the keepAlive
// LRU: the view stays alive across the migration.
//
// `withLock`'s microtask scheduling guarantees a window, right after `moveTo`
// starts, where the native migration has already landed (`current` points at
// dest) but `migrating` is still true (reset only in the lock's `finally`,
// one more microtask later) — a single `await Promise.resolve()` after
// kicking off `moveTo` lands inside it, deterministically (not a timing race):
// `handleSnapshot` (the slot-token apply path) is fully synchronous down to
// `inner.applyPlacement`, so a `visible:false` frame sent there is dispatched
// synchronously within that window.
// ─────────────────────────────────────────────────────────────────────────────
describe('applyPlacementInternal — a frame the inner sink drops is not applied to the keepAlive LRU', () => {
	it('a visible:false frame that lands mid-moveTo does not dispose the view; it survives the migration', async () => {
		const { app, electron, ipcMain, winA, winB: winBFake } = await bootTwoWindows()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 0, group: 'move-group' }
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' }, keepAlive })
		const wcv = lastWcv(electron)
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })
		const aGrant = lastSlotGrant(winA.webContents)
		expect(aGrant).not.toBeNull()

		// Establish a VISIBLE state in the reconciler first — a `visible:false`
		// snapshot with no prior visible state is a level-triggered no-op (nothing
		// to reconcile) and would never reach `applyReconciledPlacements` at all.
		const snapshot = getSnapshotHandler(ipcMain)
		await sendSnapshot(
			snapshot,
			mainFrameEvent(winA.webContents.id),
			[
				{
					slotToken: aGrant!.slotToken,
					generation: aGrant!.generation,
					placement: VISIBLE({ x: 0, y: 0, width: 5, height: 5 }),
				},
			],
			0,
		)

		// Kick off the move but DON'T await yet: the very next microtask tick lands
		// inside the "migrating" window described above.
		const movePromise = handle.moveTo(winBFake as unknown as Runtime['mainWindow'], {
			zone: 0,
			anchor: '#b',
		})
		await Promise.resolve()

		// A stale `visible:false` frame on the (still-registered, not-yet-revoked)
		// SOURCE token, mid-migration.
		sendSnapshot(
			snapshot,
			mainFrameEvent(winA.webContents.id),
			[{ slotToken: aGrant!.slotToken, generation: aGrant!.generation, placement: HIDDEN }],
			1,
		)

		await movePromise
		// Let any (buggy) fire-and-forget eviction dispose settle.
		await new Promise((r) => setTimeout(r, 0))
		await new Promise((r) => setTimeout(r, 0))

		// The view must have survived the migration — the dropped frame must not
		// have marked it evictable / evicted it.
		expect(wcv.webContents.close).not.toHaveBeenCalled()

		// And it must still be usable post-move via the dest's new token.
		const bGrant = lastSlotGrant(winBFake.webContents)
		expect(bGrant).not.toBeNull()
		await sendSnapshot(
			snapshot,
			mainFrameEvent(winBFake.webContents.id),
			[
				{
					slotToken: bGrant!.slotToken,
					generation: bGrant!.generation,
					placement: VISIBLE({ x: 1, y: 2, width: 3, height: 4 }),
				},
			],
			0,
		)
		expect(wcv.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 })

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// (b) An anchor-placed view's public applyPlacement() after dispose() must be a
// silent no-op (idempotent late IPC), like every other post-dispose call — not
// throw the "anchor-placed" guard error.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle.applyPlacement — anchor-placed view after dispose', () => {
	it('applyPlacement after dispose does not throw, even for an anchor-placed view', async () => {
		const { app } = await bootTwoWindows()
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#a' })

		await handle.dispose()

		expect(() => handle.applyPlacement(HIDDEN)).not.toThrow()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// (c) A disposed, un-anchored keepAlive view's public applyPlacement() must not
// resurrect it into a live group's `hidden` list — doing so can push the group
// over `max` and wrongly evict a DIFFERENT, still-live hidden view.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle.applyPlacement — disposed keepAlive view does not corrupt the LRU group', () => {
	it('a late frame on a disposed view does not evict another hidden view in the same group', async () => {
		const { app, electron } = await bootTwoWindows()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1, group: 'c-group' }
		const d = withView(app.runtime).view({ source: { url: 'data:text/html,d' }, keepAlive })
		d.placeIn(app.runtime.mainWindow, { zone: 0 })
		await d.dispose()

		const e = withView(app.runtime).view({ source: { url: 'data:text/html,e' }, keepAlive })
		const wcvE = lastWcv(electron)
		e.placeIn(app.runtime.mainWindow, { zone: 0 })
		e.applyPlacement(HIDDEN) // group hidden: [E]  (1 ≤ max)
		await new Promise((r) => setTimeout(r, 0))
		expect(wcvE.webContents.close).not.toHaveBeenCalled()

		// A late frame on the ALREADY-DISPOSED d — must not re-join the group.
		d.applyPlacement(HIDDEN)
		await new Promise((r) => setTimeout(r, 0))

		// E must survive: d re-joining would have pushed the group to 2 > max=1
		// and evicted the front (E).
		expect(wcvE.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})
})

/** True iff `reason` (an Error, possibly an AggregateError) mentions `needle`. */
function mentionsText(reason: unknown, needle: string): boolean {
	const seen = new Set<unknown>()
	const walk = (x: unknown): boolean => {
		if (x == null || seen.has(x)) return false
		seen.add(x)
		if (typeof x === 'string') return x.includes(needle)
		if (x instanceof Error) {
			if (x.message.includes(needle)) return true
			const agg = x as { errors?: unknown[] }
			return Array.isArray(agg.errors) && agg.errors.some(walk)
		}
		return false
	}
	return walk(reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) A window closing tears its views down through the viewScope cascade, NOT
// through hostHandle.dispose() — an anchor-placed view's public applyPlacement()
// after that cascade must still be the same idempotent no-op it is after an
// explicit dispose(), not throw the anchor-placed guard error.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle.applyPlacement — anchor-placed view after its window closes', () => {
	it('applyPlacement after a window-close cascade does not throw', async () => {
		const { app, winB } = await bootTwoWindows()
		const handle = withView(app.runtime).view({ source: { url: 'data:text/html,x' } })
		handle.placeIn(winB, { zone: 0, anchor: '#a' })

		winB._emit('closed')
		await new Promise((r) => setTimeout(r, 0))
		await new Promise((r) => setTimeout(r, 0))

		expect(() => handle.applyPlacement(HIDDEN)).not.toThrow()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// (e) An un-anchored keepAlive view whose window closes must not be resurrected
// into its LRU group by a late `visible:false` frame that lands mid-cascade —
// and must not evict a DIFFERENT, still-alive sibling living in a window that
// was never closed.
//
// The exploitable window is the gap, inside the viewScope's own teardown,
// between its FIRST LIFO-run `.own()` disposer (`onDispose`) and its second
// (`active = false`) — see view-handle.ts:352-368. That gap is closed entirely
// within a single synchronous call stack (Scope/DisposableRegistry run their
// first entry synchronously up to its own first await — see scope.ts's
// `disposeSegment` and disposable.ts's `DisposableRegistry.disposeAll`), so the
// only way to land a frame inside it is a call with NO `await` between
// `winB._emit('closed')` and the late `applyPlacement` — exactly what this test
// does.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle.applyPlacement — keepAlive view after its window closes', () => {
	it('a late frame landing mid-cascade does not rejoin the group or evict a live sibling', async () => {
		const { app, electron, winA, winB } = await bootTwoWindows()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1, group: 'cascade-group' }
		const d = withView(app.runtime).view({ source: { url: 'data:text/html,d' }, keepAlive })
		d.placeIn(winB, { zone: 0 })

		const e = withView(app.runtime).view({ source: { url: 'data:text/html,e' }, keepAlive })
		const wcvE = lastWcv(electron)
		e.placeIn(winA, { zone: 0 })
		e.applyPlacement(HIDDEN) // group hidden: [E]  (1 ≤ max)
		await new Promise((r) => setTimeout(r, 0))
		expect(wcvE.webContents.close).not.toHaveBeenCalled()

		// No `await` between these two calls — the late frame must land inside the
		// synchronous prefix of winB's close cascade, not after it settles.
		winB._emit('closed')
		d.applyPlacement(HIDDEN)

		await new Promise((r) => setTimeout(r, 0))
		await new Promise((r) => setTimeout(r, 0))

		// E (in winA, never closed) must survive: d rejoining would have pushed the
		// group to 2 > max=1 and evicted the front (E).
		expect(wcvE.webContents.close).not.toHaveBeenCalled()

		await app.shutdown()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// (f) If the native teardown inside `inner.dispose()` throws, `hostHandle.dispose()`
// must still reject with that error to the caller — but the slot-token revoke and
// keepAlive-group cleanup that follow it must run regardless, not be skipped.
// ─────────────────────────────────────────────────────────────────────────────
describe('DeckViewHandle.dispose — inner teardown throws', () => {
	it('still rejects, and still revokes the slot token and drops keepAlive membership', async () => {
		const { app, electron, winA, ipcMain } = await bootTwoWindows()

		const keepAlive: KeepAliveSpec = { policy: 'lru', max: 1, group: 'dispose-throw-group' }
		const d = withView(app.runtime).view({ source: { url: 'data:text/html,d' }, keepAlive })
		const wcvD = lastWcv(electron)
		d.placeIn(app.runtime.mainWindow, { zone: 0, anchor: '#d' })
		const grant = lastSlotGrant(winA.webContents)
		expect(grant).not.toBeNull()

		wcvD.webContents.close = vi.fn(() => {
			throw new Error('dispose-throw-boom')
		})

		let caught: unknown
		try {
			await d.dispose()
		} catch (e) {
			caught = e
		}
		expect(caught).toBeDefined()
		expect(mentionsText(caught, 'dispose-throw-boom')).toBe(true)

		// The old slot token is dead: a layout-subscribe replay unconditionally
		// resends every grant still registered under the sender's wc (it does not
		// check `disposed`) — this view's now-stale grant must NOT come back.
		const grantSends = (): number =>
			(winA.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[0] === SLOT_GRANT_CHANNEL && (c[1] as SlotGrant)?.slotToken === grant!.slotToken,
			).length
		const sendsBeforeSubscribe = grantSends()
		const layoutSubscribe = ipcMain.handlers.get(LAYOUT_SUBSCRIBE_CHANNEL)
		if (!layoutSubscribe) throw new Error(`"${LAYOUT_SUBSCRIBE_CHANNEL}" handler not registered`)
		await layoutSubscribe(mainFrameEvent(winA.webContents.id))
		expect(grantSends()).toBe(sendsBeforeSubscribe)

		// d is no longer registered in its keepAlive group: a fresh view naming
		// the same group with a DIFFERENT max establishes a new group instead of
		// warning about a conflicting max left over from d.
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		withView(app.runtime).view({
			source: { url: 'data:text/html,fresh' },
			keepAlive: { policy: 'lru', max: 5, group: 'dispose-throw-group' },
		})
		const conflictWarned = warnSpy.mock.calls.some((call) =>
			call.some((arg) => typeof arg === 'string' && arg.includes('already has max=')),
		)
		expect(conflictWarned).toBe(false)
		warnSpy.mockRestore()

		await app.shutdown()
	})
})
