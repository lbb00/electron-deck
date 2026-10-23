# electron-deck

## 1.0.0-beta.1

### Patch Changes

- 899dab5: Remove the bundle-size gate and its CI and prepack commands while keeping the tree-shaking checks.
- 899dab5: Upgrade to stable `view-anchor` 1.0.0, preserve frame-by-frame following during Dock splitter drags, and document layout epoch timing and anchor remeasurement.

## 1.0.0-beta.0

### Major Changes

- 55be4ce: Start the `1.0.0` beta series. This release includes the public API and native-view lifecycle changes described in the accompanying Changesets; existing 0.2.x consumers should review the migration notes before upgrading.

### Minor Changes

- f3c01bd: Fix native views getting stuck at their old position after a panel move

  After dragging a panel to another position or window, its native view could remain at the rectangle measured before release. A stuck hidden placement could also leave a view visible when it should disappear. Resizing the window did not recover it; the slot rectangle had to change again, the page had to navigate, or the window had to close.

  The main process recorded a placement as applied before sending it to the view. A view can reject that frame during a `moveTo` transfer, or native attachment can throw. In either case the frame never takes effect, but the recorded state already claims it did. Reconciliation is level-triggered: it produces operations only when desired and recorded state differ. Subsequent identical frames therefore produce no operations and never retry the rejected placement.

  Record the placement only after delivery. For views that reject it or throw, restore the previous recorded value so the next identical frame can retry.

  **Breaking changes to the public `electron-deck/layout` exports**:

  - The sink type accepted by `applyReconciledPlacements` changes from `(p: Placement) => void` to `(p: Placement) => boolean`, indicating whether the frame was accepted. Throwing is equivalent to returning `false`.
  - `applyReconciledPlacements` changes its return type from `void` to `Set<string>`, containing the view IDs rejected in this pass. Callers must use it to roll back their own `state.actual`; otherwise they can retain the same incorrect recorded state.
  - `ViewHandle.applyPlacement`, exported by `electron-deck/main`, also returns `boolean`. Consumers implementing `ViewHandle`, such as test doubles or adapters, must add that return value. Consumers that only call it are unaffected.

  The root entry's `DeckViewHandle.applyPlacement` signature is unchanged and still returns the handle for chaining.

- 0666b26: Remove the `simulator` concept: the wire supports only `host` calls, and `DeckConfig.simulatorApis` is removed

  `InvokeKind` previously accepted `'host' | 'simulator'`. `WireTransportDeps` required an `invokeSimulator` callback, and `WireTransport.handleInvoke` routed `kind: 'simulator'` requests to it. The root entry's `DeckConfig.simulatorApis` configured this path: hosts registered handlers that the framework exposed as global APIs in the renderer.

  `simulator` was a downstream host's business concept for running a second API set over the same wire. electron-deck itself neither produced nor consumed this kind; it merely included it in the public protocol. That extra branch forced hosts to organize a second API set in one prescribed shape, with no place for a third. Hosts can already dispatch through `invokeHost` using their own naming convention.

  `InvokeKind` is now `'host'`. Remove `invokeSimulator` from `WireTransportDeps` and remove its dispatch branch. Also remove `DeckConfig.simulatorApis` and `SimulatorApiHandler`: this `@experimental` field was used only by examples and experimental scripts, and backend assembly never read it.

  **Breaking changes**, all on the public export surface:

  - `WireTransportDeps`, exported by `electron-deck/host`, no longer has `invokeSimulator`. TypeScript's excess-property checks reject callers still passing it rather than silently ignoring it.
  - `InvokeRequest.kind`, exported by `electron-deck/preload`, is narrowed to `'host'`. Requests using `kind: 'simulator'` no longer type-check.
  - The root entry no longer exports `SimulatorApiHandler`, and `DeckConfig` no longer accepts `simulatorApis`. Configurations still passing it fail excess-property checks.
  - The root entry's `Runtime.call` no longer has `simulator(name, ...args)`. Replace `runtime.call.simulator()` with `runtime.call.host()`.

  At runtime, stray `kind: 'simulator'` requests reach the existing `UnknownKind` branch and return a structured `InvokeFailure` rather than throwing or crashing.

  Downstream hosts keeping these APIs must update both ends:

  - Move handlers from `simulatorApis` to `hostServices`. Both use the same invoke channel and sender admission checks (trusted webContents and main frame, checked before kind dispatch), so this does not change permissions or impose extra naming restrictions. The `layout.` prefix was previously reserved for privileged commands and rejected by `hostServices`. This release removes that entire privileged route (`runtime.layout.command` and its ControlBus wiring; see the separate Changeset), so the reservation is also removed. `hostServices` now accepts all names, including those starting with `layout.`, as ordinary host services with no access to a privileged path.
  - Change `kind: 'simulator'` to `kind: 'host'` at call sites. Dispatch multiple API sets by name prefix within `invokeHost`.

- 0666b26: Rename four APIs, split `draggable` into two capabilities, and fix `OverlayPanel.reposition()` behavior that contradicted its contract

  **Renames (old → new, all breaking, with no aliases)**:

  - `electron-deck/layout`: `validateTree` → `collectTreeProblems`
  - `electron-deck/layout`: `cleanSnapshot` → `authorizeSnapshot`
  - `electron-deck/layout`: `dispatchOps` → `applyReconciledPlacements`
  - `electron-deck/client`: `LayoutClientDeps.requestFrame` / `cancelFrame` → `schedulePublish` / `cancelScheduledPublish` (the injection points of `createDeckLayoutClient`; the matching `PlacementPublisherDeps` fields are renamed too)

  Consumers calling these symbols or injecting these dependency fields must replace them with the new names.

  One exception matters: **injecting cancellation without scheduling no longer works**. Previously an injected `cancelFrame` was accepted on its own. Now `cancelScheduledPublish` is used only when `schedulePublish` is also injected; cancellation alone is ignored and replaced with a no-op. This is intentional: an ID belongs to the scheduler that issued it, and using another scheduler's cancellation function could cancel work belonging to a different publisher in the same process. Test doubles that override cancellation alone should inject scheduling as well when adopting the new names.

  **Split `PanelCapabilities.draggable` into two fields**:

  Previously `draggable` controlled both whether a panel could be dragged and whether other panels could dock into its group. These are now separate:

  - `draggable?: boolean` controls whether the panel's tab can be dragged.
  - `acceptsDrops?: boolean` (new) controls whether a group with this panel as its active tab accepts docking or splits from other panels.

  **Fallback rule**: omitted `acceptsDrops` falls back to `draggable`, then to `true` (`acceptsDrops ?? draggable ?? true`). Existing registrations with `draggable: false` therefore remain unable to accept drops without changes. To keep a panel undraggable while allowing other panels to dock into it, explicitly set `acceptsDrops: true`.

  **Fix the no-op condition in `OverlayPanel.reposition()`**: it previously checked only whether a native view existed. Calling it after `prepare()` or `hide()` could show the panel again, contradicting the documented no-op behavior for a panel that is not shown. It now checks `wantsVisible`, so `reposition()` after `prepare()` or `hide()` is a true no-op. Code relying on that bug to reveal a hidden panel must call `show()` explicitly.

- 0666b26: Rename `DebugTapEntry.appSessionId` to `sessionId` in debugTap

  `appSession` was a downstream host's business concept and should not appear in electron-deck's public types.

  The field's meaning is unchanged: it is a caller-defined session identifier that distinguishes successive sessions occupying the same webContents. When `wc.id` stays the same but the occupant changes, `connectionId` alone cannot distinguish them.

  **Breaking change**: callers passing `appSessionId` to `debugTap.record()` must use `sessionId`. TypeScript's excess-property checks reject the old field rather than silently ignoring it.

  Also replace downstream-specific names (`bridge-router`, `SERVICE_INVOKE`, and `API_RESPONSE`) in the comments of `src/main/debug-tap.ts` with neutral descriptions, and use neutral module names in the examples in `docs/foundation.md`. The documentation structure and technical content are unchanged.

- 28c892c: Publish placements by default in the next macrotask after the current render step rather than the next animation frame

  When the renderer measures a changed slot rectangle, it must send the new placement to the main process. Previously this waited for the next `requestAnimationFrame`, adding about 17 ms on average in measurements. A MessageChannel macrotask now takes about 1 ms. This delay was the main contributor to native-view lag during splitter or panel dragging.

  Only the default changes. Consumers injecting `schedulePublish` into `createDeckLayoutClient` or `createPlacementPublisher` continue to use their injected scheduler.

  **Observable timing change**: a placement can now reach the main process within the same frame rather than necessarily in the next one. Recheck code depending on an implicit ordering relative to the next paint, such as changing the DOM and reading main-process state in the same tick. The measurement frequency is unchanged: view-anchor's own rAF follow loop and ResizeObserver still drive measurements, and the browser throttles both when the window is hidden.

- 0666b26: Reduce the public `@experimental` surface by removing declarative assembly and convenience APIs with no downstream consumers

  These fields and types were marked `@experimental` but had no real downstream consumers. Keeping them added compatibility paths to consider for every new contract. Remove them in favor of the imperative APIs already in use.

  Removed:

  - `DeckConfig.toolbar` / `ToolbarContribution` / `runtime.toolbarView`: the entire toolbar assembly subsystem.
  - `DeckConfig.windows` / `WindowContribution`: declarative window configuration.
  - `DeckConfig.menu` / `MenuContribution` / `MenuBuildContext`: types that never had an implementation.
  - `DeckConfig.lifecycle` / `LifecycleContribution` (including `beforeClose`).
  - `DeckConfig.setup`.
  - `runtime.grants`, `runtime.layout.command`, and `Grant.targetScope`. The general capability infrastructure in `capability.ts` under `electron-deck/host` is unchanged; `deck-app.ts` no longer provides these convenience wrappers or the privileged command route.
  - `runtime.windows.get()`. The return type of `runtime.windows.all()` is narrowed to `DeckWindow[]`.
  - The `role` in `window-created` is narrowed from `'main' | 'toolbar' | 'host'` to `'main' | 'host'` as a consequence of removing the toolbar subsystem. Comparisons with `'toolbar'` become invalid, and exhaustive switches must remove that case.

  Replacements:

  - `backend.assemble(runtime)` replaces `setup`: an assembly hook called once after runtime readiness, with the same return and throw semantics.
  - `runtime.windows.create()` (called imperatively from `assemble`) replaces declarative `windows` configuration. It remains the only path for creating child windows.
  - `backend.onShutdown` replaces `lifecycle.beforeClose`, but their timing is not equivalent. `lifecycle.beforeClose` had a default 10-second timeout; `backend.onShutdown` has no timeout and the framework awaits it indefinitely. Hosts needing a timeout should implement it in their own `onShutdown`, for example with `Promise.race`.

  Two contract changes tighten behavior rather than remove it:

  - `ViewCreateOptions.keepAlive` with `{ policy: 'lru', max }` now requires `group: string`. LRU eviction groups must be explicit instead of inferred.
  - For a view placed with a nonempty `anchor` through `placeIn` or `moveTo` (page-driven, with renderer-controlled positioning), host calls to the public `handle.applyPlacement()` now throw. Views without an anchor are unaffected and can still use `applyPlacement`.

  Also change the window parameter of `DeckViewHandle.placeIn` and `moveTo` to `BrowserWindow | DeckWindow`, accepting either directly.

  **Breaking changes**: TypeScript reports the removed properties and methods rather than silently ignoring them. Consumers using `toolbar`, declarative `windows`, `menu`, `lifecycle`, `setup`, `grants`, `layout.command`, `targetScope`, or `windows.get()` must migrate using the replacements above. Consumers using `keepAlive` must add `group`. Hosts calling `applyPlacement` on page-driven views must remove those calls because the renderer already drives their positions.

- 0666b26: Upgrade the dependency to view-anchor `1.0.0-beta.2`.

  v1 merges the previous two anchor types into `createViewAnchor` and renames `guardDisplayNone` to `treatZeroAreaAsHidden`. beta.2 no longer listens for splitter interactions on the consumer's behalf. `createDeckLayoutClient` calls the anchor's `pulse()` on splitter press and during dragging so native views continue following position-only changes.

  **Breaking change**: this affects only consumers injecting `createAnchor`. The factory receives `treatZeroAreaAsHidden` instead of `guardDisplayNone`, and its returned anchor must implement `pulse()` as well as `dispose()`. Consumers using the default factory need no changes.

  Update the size baselines for `./client` and `./client/browser` to 3266 bytes (gzip). Upgrading to beta.2 alone measured 3014 bytes; adding per-move splitter `pulse()` following measured 3266 bytes. The size gate still limits subsequent growth to 5% over the baseline.

### Patch Changes

- 0666b26: Broaden the `electron` peer dependency from `^43.2.0` to `>=30.5.1`

  The Electron APIs used by the framework (`WebContentsView`, `View.addChildView/removeChildView/children`, `BaseWindow.contentView`, and `senderFrame`) have been available since Electron 30. The previous range excluded applications on versions 30–42. Version 30.5.1 is the lowest version verified by the real Electron E2E suite; repeatedly calling `addChildView` also moves the view to the top as the compositor expects. CI now runs E2E on this minimum version as well.

  This is not a breaking change: every previously supported version remains supported.

- 0666b26: Describe the package and its keywords as a host-shell framework

  The previous `description` mentioned only “dockable panels”, presenting the package as a docking layout library. Docking is one part of it: multi-window orchestration, native `WebContentsView` instances following the DOM, overlays and popouts, and cross-process IPC are its main purpose. `/layout` and `/dock-react` provide a separate, orthogonal interface without an Electron dependency, usable independently in browser projects.

  The npm page and search results read these fields directly, so they shape a consumer's first impression. Both README summaries and the banner text use the same description.

  Add `host-shell`, `framework`, `multi-window`, and `ipc` to the keywords.
