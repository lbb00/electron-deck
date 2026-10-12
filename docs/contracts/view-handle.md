# ViewHandle contract

ViewHandle combines three primitives (Scope, Layout/Placement, and Compositor) into a per-view orchestration unit. It does not own ControlBus: grant gating is a separate tool that hosts can assemble in their own `backend.assemble`. Read this alongside `architecture.md` (primitives and host-facing API), `compositor-and-teardown.md` (compositor and teardown contracts), and `capability-and-lifecycle.md` (authorization and lifecycle contracts).

## ViewHandle types and boundaries

A handle owns exactly three things: a native reference (`NativeViewRef` and `WebContentsView`), a scope lease (a viewScope under a windowScope/wcScope, owning the native view, anchor sink, and slot-token entry), and a compositor token (the current window's `(compositor, host, windowScope)`).

**The public API has two layers with different signatures. Only the higher layer accepts `anchor`:**

```ts
// Lower-level ViewHandle (src/main/view-handle.ts): no anchor; target is { compositor, windowScope }
interface ViewHandle {
	placeIn(target: PlaceTarget, opts: { zone?: number }): ViewHandle
	applyPlacement(p: Placement): void
	moveTo(dest: PlaceTarget, opts: { zone?: number; rehome?: boolean }): Promise<void>
	dispose(): Promise<void>
	readonly webContents: unknown
	bounds(): Bounds | null
	capturePage(): Promise<unknown>
}

// Higher-level DeckViewHandle (src/types.ts, returned by `runtime.view(...)`): accepts anchor
interface DeckViewHandle {
	placeIn(window: BrowserWindow, opts: { zone?: number; anchor?: string }): DeckViewHandle
	applyPlacement(placement: ViewPlacement): DeckViewHandle
	moveTo(
		win: BrowserWindow,
		opts: { zone?: number; anchor?: string; rehome?: boolean },
	): Promise<void>
	dispose(): Promise<void>
	readonly webContents: WebContents
	bounds(): ViewBounds | null
	capturePage(): Promise<NativeImage>
}
```

Neither layer has an `anchorRect` field; that is not an API of this package. Use `applyPlacement({visible, bounds})` for a one-time coordinate placement. Both layers expose `applyPlacement`, `webContents`, `bounds()`, and `capturePage()`; the anchor-related difference is whether `placeIn` and `moveTo` accept `anchor`.

**Correctness boundaries:**

- No layout calculation: geometry comes from view-anchor publication. The handle only forwards `Placement` to `setBounds` or detach.
- No global tree: the private slot-token table and LRU groups belong to the runtime.
- No eviction-policy decisions: the runtime's keepAlive LRU helper calls `handle.dispose` (see “Keeping views alive”).
- No direct contentView manipulation: Compositor performs `addChildView` mounting and unmounting. Per-view `setBounds` is different: ViewHandle owns the `WebContentsView` and calls `.setBounds` directly. Compositor controls only z-order, not per-view bounds.

## Composition

### placeIn and mounting

The handle, factory, and `placeIn` connect Compositor (mount → commit), Scope (viewScope under windowScope), and view-anchor (placement → bounds through the injected `publish`). Each window owns a `createCompositor(win.contentView)`, consumed by ViewHandle. `Compositor.detachAll()` reduces intent to an empty target and commits it, with removals-only teardown remaining silent.

### dispose and viewScope LIFO order

`dispose()` closes viewScope in per-view LIFO order. Register `own(detach via unmount+commit)` first so it runs last, and register `own(anchorSink.dispose)` later so it runs first and stops publication. The sink must discard late in-flight bounds for a disposed handle. view-anchor guards its own emit, not the idempotency of a cross-process sink.

### Per-window teardown coordination

`closeWindow` closes windowScope and runs its LIFO teardown. Register `win.destroy` first so it runs last; append detachAll, wire disposal, and other resources afterward. deck-app has one app-level wire owned by rootScope, not one wire per window; it follows the app-level “windows before registry” order. Child viewScope resources run before these window-level resources through children-first LIFO traversal.

### moveTo across windows

Migration combines a state machine, migrationLock, and `Scope.adopt`. A per-view asynchronous mutex chains `Map<viewId,Promise>` entries. The state machine `AT_SRC→DETACHED→AT_DEST|ROLLBACK→AT_SRC|CLOSED` consumes `CommitError`; rollback always remounts at src, independently of the destination failure type. With `rehome:true`, the donor is viewScope's actual current lifetime owner, and `adopt(viewScope, destWindowScope)` transfers lifetime. By default only placement moves. Each critical section holds one per-view lock and never acquires a second, preventing deadlock.

**Placement moves; authorization does not.** Grants are keyed by the control wc's `senderId` (`Grant.senderId`, `src/host/capability.ts:22-34`) in the capability registry's own table, independently of the scope ownership graph. `Scope.adopt` transfers viewScope resource ownership without touching grants. The capability registry exported by `electron-deck/host` is a separate tool: the framework no longer wires it automatically or revokes grants on window closure. Hosts needing it must wire it in `backend.assemble` and call `capability.revokeBySenderId(srcControlWc.id)` when the source window closes. The destination has its own control shell and issues its own grants (a popout window includes its own control layer), so `moveTo` need not transfer grants. If `adopt` fails, `moveTo` removes the destination attachment and restores the native view at src; it enters `CLOSED` only if restoring src also fails.

### Slot-token handshake

`placeIn` creates a cryptographically random nonce token and a private entry `token→{viewId,authorizedWcId}`, then sends it with `controlWc.send('__deck:slot-grant')`. A per-control-wc replay buffer drains on first subscription. The inbound placement handler adds token lookup and `sender.id===authorizedWcId` checks to the wire's trust and main-frame gates; failed checks drop the report. It validates bounds: `visible:false` detaches, while `visible:true` requires nonnegative width/height and permits negative x/y. A viewScope-owned disposer removes the token entry.

### Keeping views alive

viewScope ownership of WebContents, described under “placeIn and mounting” and “dispose and viewScope LIFO order”, guarantees lifetime correctness. The opt-in runtime LRU helper supports only `lru` and `max`; omission means no framework eviction. When hidden views exceed max, it calls `dispose` on the hidden handle that has gone longest without being shown. Keep this helper small rather than extending it into a policy framework.

## Key files

- `src/main/view-handle.ts`: handle, factory, moveTo state machine, slot-token registry, and keepAlive LRU.
- `src/types.ts`: higher-level `DeckViewHandle` returned by `runtime.view(...)`.
- `src/main/compositor.ts`: `detachAll` and `CommitError`.
- `src/main/scope.ts`: viewScope leases, `adopt`, and completion fences.
- `view-anchor/src/view-anchor.ts`: `createViewAnchor` geometry source.
- `src/host/control-bus.ts` and `src/host/capability.ts`: grant gating, exported as independent tools under `electron-deck/host`. deck-app does not wire them automatically; hosts assemble them in `backend.assemble`.
- `src/internal/deck-app.ts`: runtime factory, per-window scope/compositor, wire routing, and synchronous revocation.
