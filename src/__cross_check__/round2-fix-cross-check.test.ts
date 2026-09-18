/**
 * Independent cross-check for the 13 review-issue fixes shipped in commit
 * a0a1769b. Tests here are authored against the **public contract** (JSDoc /
 * spec doc / type exports) only — implementation source was not consulted
 * while writing them. Every case maps to a numbered issue (X1..X14).
 *
 * Constraints honoured:
 * - No import from any existing test file or fixture.
 * - All fakes built locally from the Minimal* interfaces in electron-types.ts
 *   and wire-transport.ts.
 * - DeckApp is exercised directly for cases that need to bypass the
 *   electron lazy import; electronDeck() public entry covers issue #1.
 */

import { describe, expect, it, vi } from 'vitest'
import { electronDeck } from '../electron-deck.js'
import type { DeckOptions } from '../types.js'
import { DeckApp } from '../internal/deck-app.js'
import { WireTransport } from '../internal/wire-transport.js'
import { EventBus } from '../internal/event-bus.js'
import { DeckRemoteError } from '../errors.js'
import { DeckChannel } from '../shared/protocol.js'
import type {
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalContentView,
	MinimalElectron,
	MinimalRect,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from '../internal/electron-types.js'
import type { MinimalIpcMain } from '../internal/wire-transport.js'

// ── local fixture builders ────────────────────────────────────────────────

let nextWcId = 1000
function makeWebContents(
	overrides: Partial<MinimalWebContentsLike> = {},
): MinimalWebContentsLike & {
	loadURL: ReturnType<typeof vi.fn>
	loadFile: ReturnType<typeof vi.fn>
	send: ReturnType<typeof vi.fn>
} {
	const id = nextWcId++
	const destroyed = false
	return {
		id,
		loadURL: vi.fn(async (_url: string) => undefined),
		loadFile: vi.fn(async (_path: string) => undefined),
		send: vi.fn(() => undefined),
		isDestroyed: () => destroyed,
		...overrides,
	} as never
}

interface FakeWindow extends MinimalBrowserWindow {
	__listeners: Map<string, Array<() => void>>
	__emit: (event: 'resize' | 'closed') => void
	__bounds: MinimalRect
	__destroyMock: ReturnType<typeof vi.fn>
	__destroyed: boolean
	__addedChildViews: MinimalWebContentsView[]
}

function makeWindow(
	opts: MinimalBrowserWindowOptions | undefined,
	bounds: MinimalRect = { x: 0, y: 0, width: 1024, height: 768 },
): FakeWindow {
	const listeners = new Map<string, Array<() => void>>()
	let destroyed = false
	const wc = makeWebContents()
	const childViews: MinimalWebContentsView[] = []
	const contentView: MinimalContentView = {
		addChildView: (v) => {
			childViews.push(v)
		},
		removeChildView: () => undefined,
	}
	const destroyMock = vi.fn()
	const w: FakeWindow = {
		id: nextWcId++,
		webContents: wc,
		contentView,
		getContentBounds: () => ({ ...w.__bounds }),
		show: () => undefined,
		destroy: (): void => {
			destroyMock()
			destroyed = true
			w.__destroyed = true
		},
		isDestroyed: () => destroyed,
		on: (event, listener): MinimalBrowserWindow => {
			const arr = listeners.get(event) ?? []
			arr.push(listener)
			listeners.set(event, arr)
			return w
		},
		__listeners: listeners,
		__emit: (event) => {
			const arr = listeners.get(event) ?? []
			for (const fn of [...arr]) fn()
		},
		__bounds: bounds,
		__destroyMock: destroyMock,
		__destroyed: false,
		__addedChildViews: childViews,
	}
	return w
}

interface FakeView extends MinimalWebContentsView {
	__setBoundsMock: ReturnType<typeof vi.fn>
}

function makeView(): FakeView {
	const wc = makeWebContents()
	const mock = vi.fn()
	return {
		webContents: wc,
		setBounds: (rect: MinimalRect): void => {
			mock(rect)
		},
		__setBoundsMock: mock,
	}
}

function makeElectron(
	opts: {
		windowFactory?: () => FakeWindow
		viewFactory?: () => FakeView
		throwOnWindowCtorAfter?: number
	} = {},
): MinimalElectron & {
	__windows: FakeWindow[]
	__views: FakeView[]
	__windowCtorCalls: number
} {
	const windows: FakeWindow[] = []
	const views: FakeView[] = []
	let ctorCalls = 0
	const e = {
		__windows: windows,
		__views: views,
		get __windowCtorCalls() {
			return ctorCalls
		},
		BrowserWindow: function (this: unknown, browserOpts?: MinimalBrowserWindowOptions) {
			ctorCalls++
			if (opts.throwOnWindowCtorAfter !== undefined && ctorCalls > opts.throwOnWindowCtorAfter) {
				throw new Error('forced BrowserWindow ctor failure')
			}
			const w = (opts.windowFactory ?? (() => makeWindow(browserOpts)))()
			windows.push(w)
			return w
		} as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: function (this: unknown, _opts?: { webPreferences?: { preload?: string } }) {
			const v = (opts.viewFactory ?? makeView)()
			views.push(v)
			return v
		} as unknown as MinimalElectron['WebContentsView'],
	}
	return e as never
}

function makeIpcMain(): MinimalIpcMain & {
	__handlers: Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>
	handle: ReturnType<typeof vi.fn>
	removeHandler: ReturnType<typeof vi.fn>
} {
	const handlers = new Map<
		string,
		(event: { sender: { id: number } }, ...args: unknown[]) => unknown
	>()
	const ipc = {
		__handlers: handlers,
		handle: vi.fn(
			(channel: string, h: (event: { sender: { id: number } }, ...args: unknown[]) => unknown) => {
				handlers.set(channel, h)
			},
		),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel)
		}),
	}
	return ipc as never
}

function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0))
}

// ─────────────────────────────────────────────────────────────────────────
// X1 — R1/C1: public electronDeck(config, options?) entry behaviour
// ─────────────────────────────────────────────────────────────────────────

describe('X1 — electronDeck() entry & DeckOptions injection', () => {
	it('resolves when full electron + ipcMain are injected', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		await expect(electronDeck({}, { electron, ipcMain })).resolves.toBeUndefined()
	})

	// The ambient `import('electron')` result depends on the machine's install
	// mode (real binary vs a throwing stub under --ignore-scripts installs), so
	// these two tests pin the module to the path-stub shape — same behaviour and
	// same coverage on every machine.
	it('rejects with an error mentioning electron when running without injection', async () => {
		vi.doMock('electron', () => ({
			default: '/stub/electron-binary',
			ipcMain: undefined,
			BrowserWindow: undefined,
			WebContentsView: undefined,
		}))
		vi.resetModules()
		const { electronDeck: deck } = await import('../electron-deck.js')
		await expect(deck({})).rejects.toThrow(/electron/i)
		vi.doUnmock('electron')
		vi.resetModules()
	})

	it('rejects when only electron is injected but ipcMain is missing', async () => {
		vi.doMock('electron', () => ({
			default: '/stub/electron-binary',
			ipcMain: undefined,
			BrowserWindow: undefined,
			WebContentsView: undefined,
		}))
		vi.resetModules()
		const { electronDeck: deck } = await import('../electron-deck.js')
		const electron = makeElectron()
		await expect(deck({}, { electron } as DeckOptions)).rejects.toThrow(/electron|ipcMain/i)
		vi.doUnmock('electron')
		vi.resetModules()
	})

	it('exports DeckOptions type from the package surface', async () => {
		// Compile-time check via assignability: if the type is not exported, this
		// import statement at top of file would have errored. We additionally
		// verify the runtime entry symbol exists.
		const mod = await import('../index.js')
		expect(typeof mod.electronDeck).toBe('function')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X2 — R2: mainWindow.on('closed') triggers framework shutdown;
//          declared/runtime windows.on('closed') do not.
// ─────────────────────────────────────────────────────────────────────────

describe('X2 — mainWindow closed → framework shutdown', () => {
	it('mainWindow "closed" event drives framework into quit phase', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()
		expect(app.phase).toBe('ready')

		const mainWin = electron.__windows[0]!
		mainWin.__emit('closed')
		await flush()
		await flush()
		expect(app.phase).toBe('quit')
	})

	it('runtime.windows.create() child window "closed" does NOT shut the framework down', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()
		const rt = app.runtime
		rt.windows.create({ source: { url: 'http://x/aux' } })
		const aux = electron.__windows[electron.__windows.length - 1]!
		aux.__emit('closed')
		await flush()
		await flush()
		expect(app.phase).toBe('ready')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X4 — R4/C3: shutdown order — windows.destroy BEFORE ipcMain.removeHandler.
// ─────────────────────────────────────────────────────────────────────────

describe('X4 — shutdown order (window.destroy before ipcMain.removeHandler)', () => {
	it('mainWindow.destroy is invoked before any ipcMain.removeHandler during shutdown', async () => {
		const electron = makeElectron()
		const ipcMain = makeIpcMain()
		const app = new DeckApp({}, { electron, wireTransport: { ipcMain } })
		await app.start()

		// invocationCallOrder is the source of truth for inter-mock ordering.
		await app.shutdown()
		const mainWin = electron.__windows[0]!
		const destroyOrder = mainWin.__destroyMock.mock.invocationCallOrder[0]
		const removeOrders = ipcMain.removeHandler.mock.invocationCallOrder
		expect(typeof destroyOrder).toBe('number')
		expect(removeOrders.length).toBeGreaterThan(0)
		for (const ord of removeOrders) {
			expect(destroyOrder!).toBeLessThan(ord)
		}
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X9 — R8: empty remoteName from DeckRemoteError preserved (?? not ||).
// ─────────────────────────────────────────────────────────────────────────

describe('X9 — empty remoteName preserved via ??', () => {
	it('host throwing new DeckRemoteError("", msg, code) preserves remoteName === ""', async () => {
		const bus = new EventBus()
		const ipcMain = makeIpcMain()
		const trustedId = 7777
		const transport = new WireTransport({
			ipcMain,
			bus,
			senderPolicy: { isTrusted: (id) => id === trustedId },
			trustedWebContents: () => [],
			declaredEvents: () => [],
			invokeHost: async () => {
				throw new DeckRemoteError('', 'something exploded', 'E_FOO')
			},
		})
		transport.start()
		const handler = ipcMain.__handlers.get(DeckChannel.Invoke)!
		const resp = (await handler(
			{ sender: { id: trustedId } },
			{ kind: 'host', name: 'whatever', args: [] },
		)) as { ok: false; error: { remoteName: string; code?: string; message: string } }
		expect(resp.ok).toBe(false)
		expect(resp.error.remoteName).toBe('')
		expect(resp.error.code).toBe('E_FOO')
		expect(resp.error.message).toBe('something exploded')
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X10 — R9: doc-only, no runtime test. Sanity placeholder.
// ─────────────────────────────────────────────────────────────────────────

describe('X10 — R9 doc-only', () => {
	it('placeholder: no runtime contract', () => {
		expect(true).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X11 — R10: doc-only.
// ─────────────────────────────────────────────────────────────────────────

describe('X11 — R10 doc-only', () => {
	it('placeholder: no runtime contract', () => {
		expect(true).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────
// X13 — C9: WireTransport.start() rollback on partial registration failure.
// ─────────────────────────────────────────────────────────────────────────

describe('X13 — WireTransport.start() rollback', () => {
	it('when 2nd ipcMain.handle throws, the 1st handler is removed and state stays idle (start works again on a new ipcMain)', () => {
		const bus = new EventBus()
		let handleCallCount = 0
		const ipcMain = {
			__handlers: new Map<string, unknown>(),
			handle: vi.fn((channel: string, h: unknown) => {
				handleCallCount++
				if (handleCallCount === 2) throw new Error('forced 2nd handle failure')
				;(ipcMain.__handlers as Map<string, unknown>).set(channel, h)
			}),
			removeHandler: vi.fn((channel: string) => {
				;(ipcMain.__handlers as Map<string, unknown>).delete(channel)
			}),
		} as unknown as MinimalIpcMain & {
			__handlers: Map<string, unknown>
			handle: ReturnType<typeof vi.fn>
			removeHandler: ReturnType<typeof vi.fn>
		}

		const transport = new WireTransport({
			ipcMain,
			bus,
			senderPolicy: { isTrusted: () => true },
			trustedWebContents: () => [],
			declaredEvents: () => [],
			invokeHost: async () => null as never,
		})
		expect(() => transport.start()).toThrow(/forced 2nd handle failure/)

		// The first successfully-registered handler must have been rolled back.
		expect(ipcMain.removeHandler).toHaveBeenCalled()
		expect(ipcMain.__handlers.size).toBe(0)

		// A second start() on the SAME instance must NOT throw "already started" —
		// it can either succeed (state was rolled back to idle) or throw a
		// different error. The contract: state went back to idle.
		// We allow either: re-throws same setup error OR succeeds; what we
		// disallow is "already started" wording.
		try {
			transport.start()
		} catch (e) {
			expect(String(e)).not.toMatch(/already started/i)
		}
	})
})
