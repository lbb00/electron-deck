/**
 * `electron-deck/main` — main-process foundation primitives.
 *
 * Two lifetime primitives ship from here and they are NOT duplicates:
 *
 *  - `Scope` (scope.ts) — the nested lifetime primitive this package itself is
 *    built on (deck-app, view-handle, trust-set, control-bus, capability).
 *    Nestable via child/adopt, and its `reset()`/`close()` events fire AFTER
 *    `disposeAll()` completes, so a listener may assume teardown is finished.
 *  - `Connection` / `ConnectionRegistry` (connection.ts) — a FLAT per-webContents
 *    registry keyed by `wc.id`, auto-closed by `wc.once('destroyed')`. Hosts use
 *    it for "own a resource against a webContents, tear it down when that
 *    webContents dies". Its events fire when `disposeAll()` STARTS, so a
 *    listener must NOT assume the segment is already drained.
 *
 * Choosing between them: `Connection` when the lifetime is pinned to a real
 * webContents and the destroyed-hook plus id-keyed lookup are worth having;
 * `Scope` when you need nesting or a completion barrier.
 * See docs/contracts/unified-lifetime.md §5 for the full comparison.
 *
 * NOTE: `Connection` and `debugTap` have no call sites inside this package.
 * That is expected — they are published surface for downstream hosts, not dead
 * code. Check consumers before touching either.
 */
export {
  createConnectionRegistry,
  type Connection,
  type ConnectionRegistry,
} from './connection.js'
export {
  DisposableRegistry,
  SyncDisposableRegistry,
  toDisposable,
  type Disposable,
  type DisposeFn,
} from './disposable.js'
export { createScope, type Scope } from './scope.js'
export {
  createCompositor,
  CommitError,
  type Compositor,
  type ContentViewHost,
  type NativeViewRef,
} from './compositor.js'
export {
  createViewHandle,
  type ViewHandle,
  type ViewHandleDeps,
  type NativeView,
  type PlaceTarget,
  type Placement,
  type Bounds,
} from './view-handle.js'
export { createLogger, setLogLevel, type Logger } from './logger.js'
export {
  isMainFrameIpcSender,
  type IpcSenderPolicy,
} from './ipc-sender.js'
export {
  addMuxedInvokeHandler,
  addMuxedSyncListener,
  type InvokeMuxEntry,
  type MuxEntry,
  type SyncMuxEntry,
} from './ipc-mux.js'
export { windowHostsWebContents } from './window-hosts.js'
export {
  createDebugTap,
  type DebugTap,
  type DebugTapEntry,
  type DebugTapOptions,
} from './debug-tap.js'
export {
  createOverlayPanel,
  type OverlayPanel,
  type OverlayPanelBounds,
  type OverlayPanelDeps,
  type OverlayPanelElectron,
  type OverlayPanelWebPreferences,
} from './overlay-panel.js'
