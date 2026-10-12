import type { BrowserWindow, NativeImage, WebContents, ipcMain } from 'electron'
import type { MinimalApp, MinimalElectron } from './internal/electron-types.js'
import type { MinimalIpcMain, MinimalWebContents } from './internal/wire-transport.js'

export type MaybePromise<T> = T | Promise<T>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [k: string]: JsonValue } | readonly JsonValue[]

export interface Disposable {
	dispose(): void | Promise<void>
}

/**
 * `@experimental` convention (used throughout this file)
 * --------------------------------------------------------
 * The high-level host-shell surface — `runtime.windows.*` (Window facade),
 * `runtime.view` / `DeckViewHandle`, `runtime.scopes` / `DeckSession` — is
 * fully built and wired, but has NO production consumer yet: the only caller
 * is `examples/layout-demo`.
 * Downstream host integrations use the `RuntimeBackend` lifecycle path with
 * `ownsWindows:true` and never touch this surface.
 *
 * Until a SECOND, real consumer adopts it, these signatures are NOT API-stable —
 * treat them as `@experimental`. Do not assume any of it is validated against a
 * non-demo workload.
 */

/** Opaque session handle minted by `runtime.scopes.create()` (app-root) or
 *  `DeckWindow.newSession()` (window-rooted). Wraps a child Scope, so disposing
 *  it (or app shutdown / window close) tears down every view bound to it. Does
 *  NOT expose the internal Scope (no adopt/child escape).
 *  @experimental No production consumer yet — see the convention note above. */
export interface DeckSession {
	/** Release THIS session's views (and any other owned resources of its current
	 *  segment), keeping the session AND its window alive — a fresh segment opens. */
	reset(): Promise<void>
	/** Terminal: dispose every view bound to the session and close it. */
	dispose(): Promise<void>
}

/** A per-window close decision. `'keep'` vetoes the close; `'close'` proceeds.
 *  @experimental Only reached via the {@link DeckWindow} facade — see the
 *  convention note above. (`RuntimeBackend.onMainWindowClose` uses an inline
 *  `'keep' | 'close'`, not this alias.) */
export type WindowCloseDecision = 'keep' | 'close'
/** A cancelable per-window close decider registered via {@link DeckWindow.onClose}.
 *  @experimental No production consumer yet — see the convention note above. */
export type WindowCloseDecider = () => MaybePromise<WindowCloseDecision>

/**
 * Opaque handle over a framework-registered window (`runtime.windows.create()`
 * / `runtime.windows.main`). Exposes the BrowserWindow + its control wc, a
 * window-rooted session factory, and a per-window cancelable close decider.
 *
 * **Never exposes** the raw windowScope / substrate / trust lease.
 *
 * @experimental No production consumer yet — see the convention note above.
 */
export interface DeckWindow {
	/** The BrowserWindow this handle wraps. */
	readonly window: BrowserWindow
	/** The window's primary control WebContents (=== `window.webContents`),
	 *  captured once at registration. */
	readonly controlWc: WebContents
	/** Mint a window-rooted {@link DeckSession} (a child of this window's lifetime).
	 *  `runtime.view({ scope })` accepts it under the same provenance check as an
	 *  app-root session; closing the window cascades every session minted here. */
	newSession(): DeckSession
	/** Register a per-window cancelable close decider. On a close attempt the
	 *  framework `preventDefault()`s, runs the registered deciders in registration
	 *  order; any `'keep'` vetoes, else the window is destroyed. On the MAIN window
	 *  a live decider supersedes {@link RuntimeBackend.onMainWindowClose}. */
	onClose(decider: WindowCloseDecider): Disposable
}

/**
 * HostEvent created by `defineEvent(name)`, a pure factory with no side effects.
 * The event must be explicitly listed in `DeckConfig.events` for the framework to bind its transport.
 *
 * `@experimental` No production consumer yet — only `examples/` uses
 * `defineEvent` / `DeckConfig.events`; the `backend` integration path never
 * touches either. Contract may change until a second real consumer adopts it.
 */
export interface HostEvent<P extends JsonValue> {
	readonly name: string
	publish(payload: P): void
	on(listener: (payload: P) => void): Disposable
}

// ── DeckConfig top level ──────────────────────────────────────────────

/**
 * Handler parameters deliberately use `never[]` so a narrower host signature such as
 * `(p: { code: string }) => ...` remains assignable to `Record<string, Handler>`.
 * Rest parameters are checked contravariantly: `never` is assignable to any concrete
 * parameter type, whereas `unknown` would reject that narrower signature.
 * The framework validates JSON at the IPC boundary. On the webview side,
 * `createDeckClient<HS, EV>()` infers the narrower types through `Parameters<HS[K]>`.
 * The framework does not constrain the TypeScript return type, but at runtime the
 * result must be JSON-safe; non-JSON values fail during deserialization.
 *
 * `@experimental` No production consumer yet: only `examples/` sets
 * `DeckConfig.hostServices`; the `backend` integration path never touches it.
 * Contract may change until a second real consumer adopts it.
 */
export type HostServiceHandler = (...args: never[]) => unknown

export interface AppConfig {
	readonly name?: string
	readonly icon?: string
	/**
	 * Optional content source for the framework-built main window. When set AND
	 * the framework owns the main window (NOT an `ownsWindows:true` backend), the
	 * framework auto-loads it after the window is built. Omitted → the host owns
	 * the load. Ignored
	 * under an `ownsWindows:true` backend (the backend builds + loads its own window).
	 */
	readonly source?: WebviewSource
	/**
	 * Opt-in process-lifecycle: bind `window-all-closed`. Omitted → the framework
	 * does NOT touch `window-all-closed` (Electron's default, or the consumer's own
	 * handler, applies). `true` → quit when all windows close; `false` → bind but
	 * suppress the default quit.
	 */
	readonly quitOnAllWindowsClosed?: boolean
	/**
	 * Opt-in single-instance lock. When true, `start()` acquires the OS
	 * single-instance lock before `whenReady`; a second instance quits immediately.
	 * `second-instance` is forwarded to {@link RuntimeBackend.onSecondInstance}.
	 */
	readonly singleInstance?: boolean
	readonly window?: {
		readonly width?: number
		readonly height?: number
		readonly minWidth?: number
		readonly minHeight?: number
		readonly show?: boolean
		readonly backgroundColor?: string
		readonly webPreferences?: Record<string, unknown>
	}
}

export type WebviewSource = { readonly url: string } | { readonly file: string }

/**
 * The second parameter of the top-level `electronDeck(config, options?)` call.
 *
 * **Production:** omit it. The framework lazily uses `await import('electron')` to obtain
 * real `ipcMain`, `BrowserWindow`, and `WebContentsView` dependencies. Hosts can call
 * `electronDeck(config)` directly from the Electron main-process entry point without manual injection.
 *
 * **Tests / non-Electron environments:** explicitly supply both `{ electron, ipcMain }` to bypass
 * the lazy import. Under Vitest, `await import('electron')` resolves to the package entry stub,
 * which exports an executable-path string rather than the main-process module;
 * `ipcMain` and `BrowserWindow` are therefore undefined. If the lazy import cannot provide
 * `ipcMain`, the framework throws a clear error asking the caller to inject it.
 *
 * `trustedWebContents` and `senderPolicy` are optional overrides. By default, the framework
 * uses its internally maintained trusted set and the default isTrusted policy.
 *
 * `backend` belongs to {@link DeckConfig}: it determines which domain-specific backend
 * assembles this deck, rather than providing a test dependency override.
 */
export interface DeckOptions {
	/** Inject custom Electron dependencies (test fakes or production overrides); defaults to a lazy import of real Electron. */
	readonly electron?: MinimalElectron
	/** Inject ipcMain; by default, the framework uses lazy-imported electron.ipcMain. */
	readonly ipcMain?: MinimalIpcMain
	/** Override the trustedWebContents callback; defaults to the framework-maintained set. */
	readonly trustedWebContents?: () => readonly MinimalWebContents[]
	/** Override senderPolicy; defaults to checking membership in the trusted set. */
	readonly senderPolicy?: SenderPolicy
}

export interface DeckConfig {
	readonly app?: AppConfig
	/**
	 * Domain-specific backend. When supplied, the framework runs `beforeReady` before readiness
	 * and `assemble` during setup, leaving main-window assembly to the backend instead of creating its own window.
	 * Backend hosts use `electronDeck({ backend })` directly, without an empty `{}` plus options.
	 */
	readonly backend?: RuntimeBackend
	/** RPC exposed to trusted webviews.
	 *  @experimental No production consumer yet — only `examples/` sets this;
	 *  the `backend` integration path never touches it. */
	readonly hostServices?: Record<string, HostServiceHandler>
	/** Main → webview event pushes; explicitly list events to avoid registration depending on module load order.
	 *  @experimental No production consumer yet — only `examples/` sets this;
	 *  the `backend` integration path never touches it. */
	readonly events?: readonly HostEvent<JsonValue>[]
}

// ── Runtime ──────────────────────────────────────────────────────────────

export interface TypedIpcRegistry {
	handle<A extends JsonValue[], R extends JsonValue>(
		channel: string,
		handler: (...args: A) => MaybePromise<R>,
		options?: {
			validator?: (args: unknown[]) => A
		},
	): Disposable
	on<P extends JsonValue>(channel: string, listener: (payload: P) => void): Disposable
	send(target: 'mainWindow' | BrowserWindow, channel: string, payload: JsonValue): void
}

export interface SettingsSnapshot {
	readonly theme: 'light' | 'dark'
	readonly [k: string]: JsonValue
}

export interface SenderPolicy {
	/** Check the trusted webContentsId set maintained by the framework. @internal */
	isTrusted(senderId: number): boolean
}

export interface ResourceRegistry {
	/** @internal LIFO dispose */
	add(d: Disposable | (() => MaybePromise<void>)): Disposable
	disposeAll(): Promise<void>
}

export interface DeckContext {
	readonly settings: SettingsSnapshot
	readonly theme: 'light' | 'dark'
	/** @internal Unsupported escape hatch; bypasses the I1/I2/I3 service guarantees. */
	readonly _registry: ResourceRegistry
	/** @internal unsupported escape */
	readonly _senderPolicy: SenderPolicy
}

export interface FrameworkEvents {
	'window-created': { window: BrowserWindow; role: 'main' | 'host' }
	'window-closed': { window: BrowserWindow }
	/** Emitted when webContents.loadURL/loadFile fails. Loading failures do not reject start(); hosts can subscribe to provide fallback behavior or retry. */
	'load-failed': { source: WebviewSource; error: unknown }
}

/** @experimental Window facade option bag — no production consumer yet (see the
 *  convention note above). */
export interface WindowCreateOptions {
	readonly source: WebviewSource
	readonly preloadPath?: string
	readonly width?: number
	readonly height?: number
	readonly modal?: boolean
	readonly parent?: BrowserWindow
	/** Default true */
	readonly autoTrust?: boolean
}

/** A screen-space rectangle (CSS px), mirroring the `view-handle` `Bounds`.
 *  @experimental Part of the host-view surface — no production consumer yet (see
 *  the convention note above). */
export interface ViewBounds {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/**
 * Explicit visibility + geometry for a host-managed native view. Structurally
 * identical to the internal `view-handle` `Placement`; re-declared here so the
 * public `Runtime` surface adds no internal-module dependency.
 *
 * @experimental Part of the host-view surface — no production consumer yet (see
 * the convention note above).
 */
export type ViewPlacement =
	| { readonly visible: true; readonly bounds: ViewBounds }
	| { readonly visible: false }

/** Options for {@link Runtime.view}.
 *  @experimental No production consumer yet — see the convention note above. */
export interface ViewCreateOptions {
	readonly source: WebviewSource
	/** The view's home lifetime — a {@link DeckSession} from
	 *  `runtime.scopes.create()`. Disposing the session detaches + unregisters the
	 *  view (display teardown) and closes its native WebContents; because the
	 *  session is a child of the app root, app shutdown also cascades into it.
	 *  Omitting it binds the view to the app root (no per-session teardown; the
	 *  view's display still tears down with its placeIn window, and shutdown closes
	 *  it). A raw/foreign Scope is REJECTED — only a session minted by
	 *  `runtime.scopes.create()` is accepted (provenance check). */
	readonly scope?: DeckSession
	/**
	 * Opt-in keep-alive eviction policy (opt-in LRU helper). When set, the framework disposes
	 * the least-recently-VISIBLE HIDDEN view in `group` once the group's HIDDEN
	 * count exceeds `max` — destroying that view's native WebContents.
	 * Currently-visible views are NEVER evicted. Views sharing the same `group`
	 * form one LRU set (explicit — no longer inferred from `max`); the group's
	 * `max` is fixed by whichever view joins it first, so a later view declaring a
	 * different `max` for the same `group` is a config conflict (warned, the
	 * group's established `max` wins). Omitting `keepAlive` → the framework
	 * evicts nothing (pure host management; the host decides what to keep).
	 */
	readonly keepAlive?: { readonly policy: 'lru'; readonly max: number; readonly group: string }
}

/**
 * A host-API handle over ONE native view (`runtime.view(...)`). Chainable:
 * `placeIn` and `applyPlacement` both return the handle so calls compose.
 * `dispose` detaches the view and makes the placement sink inert.
 *
 * @experimental No production consumer yet — see the convention note above.
 */
export interface DeckViewHandle {
	/** Mount the native view into `window`'s content view at the given zone.
	 *  A non-empty `anchor` names a DOM slot in the control wc: the host mints a
	 *  slot-token for it and pushes a slot-grant so the renderer can drive
	 *  `place` on this view. Omitting it mounts without a renderer credential.
	 *  Chainable. */
	placeIn(
		window: BrowserWindow | DeckWindow,
		opts: { zone?: number; anchor?: string },
	): DeckViewHandle
	/** Drive the native view's visibility + bounds. `visible:true` (re)mounts and
	 *  sets bounds directly; `visible:false` detaches but keeps the view alive.
	 *  A frame after `dispose` is dropped. Chainable.
	 *
	 *  A view currently placed with a non-empty `anchor` (either `placeIn` or
	 *  `moveTo`) is PAGE-DRIVEN — the renderer owns its position via the
	 *  slot-token protocol. Calling this for such a view THROWS: position is
	 *  either host-driven (no anchor, host calls `applyPlacement`) or
	 *  page-driven (anchor, page drives placement) — never both. */
	applyPlacement(placement: ViewPlacement): DeckViewHandle
	/** Migrate the placed view to another window (the ONLY re-placement path —
	 *  placeIn twice throws). Moves the per-window substrate registration + re-issues
	 *  the slot-token anchor for the dest; atomic (rolls back to the source on dest
	 *  failure). `rehome:true` re-parents the view's lifetime to the dest window. */
	moveTo(
		win: BrowserWindow | DeckWindow,
		opts: { zone?: number; anchor?: string; rehome?: boolean },
	): Promise<void>
	/** Tear down this placement (detach the native view, disable the sink). */
	dispose(): Promise<void>
	/** The native view's `WebContents`. Available immediately — the handle owns
	 *  its view before any `placeIn`, so a caller can recover the WebContents (and
	 *  its bounds/screenshot below) without diffing `mainWindow.contentView.children`. */
	readonly webContents: WebContents
	/** The view's LIVE screen-space rect when it is currently placed AND visible;
	 *  `null` before any placement, after `applyPlacement({visible:false})`, and
	 *  after `dispose()`. */
	bounds(): ViewBounds | null
	/** Capture the native view as a `NativeImage` (pass-through to the view's
	 *  `webContents.capturePage()`). */
	capturePage(): Promise<NativeImage>
}

export interface Runtime {
	readonly electron: typeof import('electron')
	readonly mainWindow: BrowserWindow

	readonly ipc: TypedIpcRegistry
	readonly rawIpcMain: typeof ipcMain

	readonly call: {
		host(name: string, ...args: JsonValue[]): Promise<JsonValue>
	}

	/** @experimental Window facade — no production consumer yet (see the
	 *  convention note near the top of this file). */
	readonly windows: {
		create(opts: WindowCreateOptions): DeckWindow
		/** Every live framework-tracked {@link DeckWindow} (the framework-built main
		 *  window plus any `runtime.windows.create()`-spawned window); a destroyed
		 *  window drops out. Get at a bare `BrowserWindow` via `.window`. */
		all(): DeckWindow[]
		/** The framework-built main window's {@link DeckWindow}, or `null` when the
		 *  framework does not own a main window (e.g. an `ownsWindows:true` backend). */
		readonly main: DeckWindow | null
		trust(win: BrowserWindow): Disposable
		/**
		 * Register an EXTERNALLY-created window (one the host built itself, e.g.
		 * under a `ownsWindows:true` backend) into the framework: its windowScope,
		 * per-window native-view substrate, and TRUST lifecycle — so
		 * `runtime.view().placeIn(win)` works for it. Trust + slot-tokens
		 * for the window's webContents are revoked SYNCHRONOUSLY and FIRST on the
		 * window's `'closed'` (the framework arms its revoke via `prependListener`,
		 * so it runs before any external `'closed'` listener the host registered
		 * earlier — a host listener must never observe a still-trusted wc whose id
		 * Electron may immediately reuse).
		 *
		 * Idempotent by webContents identity: adopting the same window twice returns
		 * the existing registration (no second substrate, no double trust lease).
		 * Throws if the window (or its webContents) is already destroyed — a dead
		 * wc.id could be reused, so admitting one would be a privilege-escalation
		 * hazard.
		 *
		 * `ownership`:
		 *  - `'transfer'` → the framework owns the window's lifetime and destroys it
		 *    at app shutdown (as it does for its own windows).
		 *  - `'observe'` (default) → the HOST owns the window's lifetime; the
		 *    framework NEVER calls `destroy()` on it, but still tears down the
		 *    substrate + trust when the registration is disposed or the app shuts down.
		 *
		 * The returned {@link Disposable} un-adopts the window early (tears down its
		 * substrate + trust); it is idempotent.
		 */
		adopt(win: BrowserWindow, opts?: { ownership?: 'transfer' | 'observe' }): Disposable
	}

	/** Create a host-managed native view and return a chainable handle. Throws
	 *  if the build has no Electron (mirrors `windows.create`).
	 *  @experimental No production consumer yet — see the convention note above. */
	view(opts: ViewCreateOptions): DeckViewHandle

	/** Session factory. `create()` mints an opaque {@link DeckSession} (internally
	 *  a child of the app root) — the ONLY legitimate source of a `scope` for
	 *  `runtime.view`. Disposing the session tears down every view bound to it;
	 *  app shutdown also cascades into it.
	 *  @experimental No production consumer yet — see the convention note above. */
	readonly scopes: {
		create(): DeckSession
	}

	readonly context: DeckContext

	on<E extends keyof FrameworkEvents>(
		event: E,
		listener: (payload: FrameworkEvents[E]) => void,
	): Disposable

	add(d: Disposable | (() => MaybePromise<void>)): Disposable
}

// ── RuntimeBackend ─────────────────────────────────────────────────────────

/**
 * Frame-aware sender identity for trust checks. `frame` is null when the
 * platform cannot resolve a sender frame (e.g. some sync paths / destroyed
 * frames) — callers decide fail-closed vs sender-level fallback per channel.
 */
export interface TrustedSenderRef {
	readonly webContentsId: number
	readonly frame: {
		readonly url: string
		readonly isMainFrame: boolean
		readonly processId: number
		readonly routingId: number
	} | null
}

/**
 * Domain backend injected into the framework. The framework owns process
 * lifecycle / windows / wire / trust primitives; the backend supplies the
 * domain assembly (real context, mainWindow content, native views, IPC
 * modules) the framework is deliberately ignorant of. All hooks except
 * `assemble` are optional; absent hooks fall back to framework defaults.
 *
 * @internal exported via `/host` for backend implementers.
 */
export interface RuntimeBackend {
	/**
	 * When true, the backend builds the main window itself (in `assemble`) and
	 * the framework skips its own window assembly — used
	 * by hosts whose window needs construction-time options the generic factory
	 * can't express (e.g. a per-session preload partition). Default false: the
	 * framework owns the window and the backend only reacts (onMainWindowClose).
	 */
	readonly ownsWindows?: boolean
	/**
	 * Pre-ready side effects (scheme/protocol registration, command-line
	 * switches, app name). Runs after electron is resolved but BEFORE
	 * `app.whenReady()`; receives the framework's resolved {@link MinimalApp}.
	 * Throwing aborts start() via cleanupOnError.
	 */
	beforeReady?(app: MinimalApp): MaybePromise<void>
	/**
	 * Domain assembly. Runs in setup phase, after the runtime skeleton is built
	 * and the wire transport is live. Loads the main renderer, registers domain
	 * IPC modules, stands up its own native views, etc.
	 */
	assemble(runtime: Runtime): MaybePromise<void>
	/**
	 * Construction-time `webPreferences` for the framework-built main window.
	 * Called once, synchronously, BEFORE `new BrowserWindow(...)` in the
	 * `ownsWindows` falsy path. The returned prefs are merged into the window's
	 * `webPreferences` and take precedence over `config.app.window.webPreferences`
	 * on key collision. Only consulted when the framework owns the main window.
	 */
	mainWindowWebPreferences?(): Record<string, unknown> | undefined
	/**
	 * Called once, synchronously, AFTER the framework constructs the main window
	 * and BEFORE any content load (loadFile/loadURL). Receives the framework-built
	 * main window and the injected electron module so the backend can attach
	 * listeners / views / state before the renderer starts. Only fires in the
	 * `ownsWindows` falsy path.
	 */
	onMainWindowCreated?(win: BrowserWindow, electron: typeof import('electron')): void
	/**
	 * Called when the framework edge-trusts one of its webContents — covers the
	 * framework-built main window as well as framework-built declared / host /
	 * runtime-created windows. Lets the backend mirror trust into the domain
	 * trust set. Returns a Disposable the framework disposes on untrust / window
	 * destroy.
	 */
	onWindowTrusted?(wc: MinimalWebContents): Disposable
	/**
	 * Main-window `close` decision (cancelable). `'keep'` → framework keeps the
	 * window (backend has already torn down its session / navigated back);
	 * `'close'` → framework destroys the window and shuts down. Must NOT call
	 * close/destroy itself; must finish any flush before returning `'close'`.
	 */
	onMainWindowClose?(): MaybePromise<'keep' | 'close'>
	/** Framework resize hook — backend repositions its overlays against the
	 *  framework-built main window that emitted `resize`. */
	repositionOverlays?(win: BrowserWindow): void
	/**
	 * Fired on `second-instance` when `config.app.singleInstance` is set and this
	 * process holds the lock — the backend typically focuses/restores its main
	 * window. Process-level: fires regardless of `ownsWindows`.
	 */
	onSecondInstance?(): void
	/**
	 * Deterministic shutdown hook. AWAITED exactly ONCE during `app.shutdown()`'s
	 * cleanup, BEFORE any scope teardown — so a backend no longer hand-rolls
	 * `app.once('before-quit', ...)`. There is NO timeout: shutdown waits as long
	 * as this takes, so a backend that needs one must impose it itself.
	 * Best-effort otherwise: a throw/reject is logged and does NOT abort the rest
	 * of shutdown. Fires regardless of `ownsWindows`.
	 */
	onShutdown?(): void | Promise<void>
}
