# electron-deck architecture: layout and multiple windows

> For engineers new to this package: this document explains the layout and multi-window primitives, their responsibility boundaries, and host usage. Read alongside:
>
> - `docs/foundation.md`: the Connection, Disposable, and Scope foundation.
> - `docs/layout-architecture-demo.md`: minimal host-facing usage, complementing section 4.
> - `view-anchor/README.md`: the independent Layout/Placement package documentation.

---

## 0. Purpose and relationship to dockview

**electron-deck is a domain-neutral Electron host-shell framework.** Its host-shell layer does not implement DOM splits inside windows. Instead, it provides four orthogonal primitives for nested lifetimes, DOM-rectangle/native-bounds following, per-window native z-order, and IPC/trust boundaries (section 2). Hosts, from preview tools to arbitrary multi-window Electron applications, combine windows, native views, overlays, and popouts with little host code.

**dockview and electron-deck have complementary responsibilities.** dockview, or any CSS/React split library, is authoritative for in-window DOM layout: split/grid/tab state belongs to the renderer control layer. Its `OverlayRenderContainer` uses `getBoundingClientRect → RAF → reposition` to attach a DOM follower to a panel. view-anchor applies the same mechanism across processes, where the follower is a main-process native `WebContentsView`; see `view-anchor/src/types.ts` for the cross-process bridge dockview deliberately does not provide.

> dockview divides the DOM; electron-deck makes native views follow that DOM, moves them across windows, and assigns their lifetimes.

> The host-shell primitives in sections 1–5 (Scope, Compositor, ControlBus, ViewHandle, and the Window API) do not split the DOM. The package also provides an independent, domain-neutral in-window layout interface: the layout-as-data engine (`/layout`) and `<DockView>` (`/dock-react`), described in section 0.5. These interfaces are orthogonal: host-shell does not depend on the layout engine, and the layout engine does not import Electron. Hosts may use either alone. Using both together follows the `ownsWindows:true` integration path rather than the higher-level host-shell API in section 4.

---

## 0.5. Layout-as-data engine and DockView

The second public interface is orthogonal to the host-shell primitives in sections 1–5. It gives Electron tools domain-neutral in-window docking: draggable re-docking, tabs, splits, and serialized layout restoration for IDE-style interfaces.

### 0.5.1 Layout-as-data engine (`electron-deck/layout`)

**Pure TypeScript:** `src/layout/` must not import `electron` or `react`; `boundary.test.ts` enforces this boundary. Native panels reference an Electron-free opaque `NativeHandleRef`, which the host maps to a real view.

- **Data model:** an immutable `LayoutTree`, with `SplitNode` row/column containers holding one `sizes` weight per child and optional `constraints` (`{fixedPx}` fixes size; `{minPx}` sets a flexible minimum), or `TabGroupNode` containing panel IDs and the current `active` panel.
- **Panel registration:** `PanelDescriptor` distinguishes `dom` React content in the renderer from `native` main-process views carrying `NativeHandleRef`. `createPanelRegistry()` maps panel IDs to descriptors.
- **Pure tree-to-tree mutations:** `movePanel`, `splitPanel`, `closePanel`, `setActive`, `setSizes`, `setConstraint`, `extractPanel`, and `insertPanel`.
- **Serialization and validation:** `serializeLayout` and `parseLayout` round-trip an opaque persisted string. `collectTreeProblems` checks structural validity and whether all panel IDs are known, supporting restoration with a safe fallback.
- **Observable model:** `createLayoutModel(tree)` creates a single-writer `LayoutModel` with `get`, `apply(mut)`, and `subscribe(snap)` to broadcast tree changes to renderers.

### 0.5.2 `<DockView>` (`electron-deck/dock-react`)

`<DockView model registry renderDomPanel bindNativeSlot>` renders a `LayoutModel` as React docking UI:

- `renderDomPanel(panelId, { active })` renders DOM content. `bindNativeSlot(panelId, el)` gives the host an empty DOM slot for a native panel. The host uses view-anchor to attach the main-process view to that slot through the same cross-process bridge as section 2.2.
- **DOM panel retention:** all DOM panels in a tab group remain mounted. Inactive panels use `display:none`, preserving scroll position and expansion state without remounting. The `active` flag lets panels run activation effects (such as refresh) on false → true without relying on mount. **Native panels differ:** only active panels mount, because hiding a bound WebContentsView slot collapses its rectangle. Deactivation unmounts it and calls `bindNativeSlot(panelId, null)` for cleanup.
- Users drag tabs into drop zones for split/tab re-docking through HTML5 DnD, resize separators, switch tabs, and close panels. Tab close controls call `closePanel`, protecting the last panel in the whole tree. The entry also exports pure drop geometry and descriptors (`computeDropZone`, `dropZoneToMutation`, `isNoopRedock`), avoiding deep imports.
- Leaf constraints can fix a pixel size with `{fixedPx}` or set a flexible minimum with `{minPx}`, such as a preview column that can grow but never become narrower than a device.
- **The model is authoritative for visible splits, with two-way synchronization.** react-resizable-panels (rrp) reads `defaultSize` only at mount. `SplitView` therefore holds its imperative `Group` handle: model → view uses `setLayout` for programmatic `setSizes`, moving mounted separators without remounting; view → model uses `onLayoutChanged` for pointer or keyboard resize.
- Write-back deduplicates by **flexible proportions**. Normalize the rrp container percentages and model weights over flexible (non-fixed-pixel) children only; write back only when the difference exceeds 0.1 percentage points. This distinguishes real user resizing from `setLayout` echoes or proportional remeasurement without pointer gating or echo tokens. Fixed-pixel weights stay unchanged because their constraints, not weights, determine size.

### 0.5.3 Relationship to sections 1–5

The layout engine does not use Scope, Compositor, ControlBus, or the Window API and does not require hosts to adopt them. The host-shell primitives likewise do not depend on the engine. A host may use both through different integration points: `/layout` and `/dock-react` divide the DOM, while `ownsWindows:true` handles host-owned window assembly and native-view lifetime.

---

## 1. Three requirements and one physical constraint

These primitives follow from three concrete requirements and an Electron constraint.

### Requirement A: closing a project returns to main without closing the window

Closing the current project must destroy all project resources (preview views, CDP, debugging views, and so on), keep the window, and return to the project list. This requires nested lifetime: window lifetime contains session lifetime. Project close resets the session while preserving the window. This is **Scope**'s responsibility.

### Requirement B: the renderer controls layout through IPC

Split proportions, panel popouts, and dropdowns are application interactions rather than fixed main-process behavior. The renderer control layer needs trusted IPC to send resize/reorder/popout intent to main, which drives native views. A permission boundary must prevent one window's control layer from manipulating another window. This uses **ControlBus** and capabilities.

### Requirement C: overlays appear above native views

Settings panels and dropdowns must appear above native panel views.

### Physical constraint

**Electron's native WebContentsView composition is always above the DOM. Native views and DOM elements cannot interleave along the z-axis.** Therefore:

- A dropdown above a native panel must itself be a native view in a higher z zone. A DOM element remains below native views.
- A main-process native z-order planner must control multiple native views in one window. A DOM library such as dockview cannot manage that layer. This is **Compositor**'s responsibility.

Making a native view follow its DOM slot during splitter dragging is **Layout/Placement (view-anchor)**'s responsibility.

---

## 2. Four orthogonal primitives and a small ViewHandle

The architecture combines four independently testable primitives with a small ViewHandle orchestration layer. Each primitive has one responsibility and does not depend on the others.

```
                      ┌──────────────────────────────────────────────────────┐
   host backend ──►   │                 ViewHandle                           │
   runtime.view()     │ native view + scope lease + compositor token         │
                      └───┬──────────────┬──────────────────┬─────────────────┘
                          │              │                  │
                  ┌───────▼──────┐ ┌─────▼─────────┐ ┌──────▼──────────┐ ┌─────────────────┐
                  │ Scope        │ │ Compositor    │ │ Layout/Placement│ │ ControlBus      │
                  │ nested life  │ │ per-window z  │ │ view-anchor     │ │ IPC + trust     │
                  │ own/child    │ │ mount/commit  │ │ DOM rect ↔      │ │ command/event   │
                  │ reset/close  │ │ + LIS diff    │ │ native bounds   │ │ /trust          │
                  │ fence/adopt  │ │               │ │ Placement{vis}  │ │ → WireTransport │
                  └──────────────┘ └───────────────┘ └─────────────────┘ └─────────────────┘
```

### 2.1 Scope: nested lifetime

Scope represents a lifetime segment: `own()` registers resources and `child()` creates a child lifetime. `reset()` tears down the current segment and opens another while keeping Scope alive; `close()` terminates it and all resources. Cleanup is LIFO across generations: grandchildren, children, then parents.

**Unlike `connection.ts`, reset/close are completion fences.** Their Promises resolve and listeners fire only after underlying asynchronous `disposeAll` finishes. A parent's `await child.close()` is a real wait; in-flight teardown is shared and reentrant calls join it.

**adopt** moves a child from one parent's segment to another without resetting or closing it. Its owned resources remain intact; only responsibility for future teardown changes. If either side has teardown in flight, adopt waits for the fence rather than throwing, then revalidates against fresh segments. This underlies popout lifetime transfer.

- File: `src/main/scope.ts` contains the interface, adopt, and the shared in-flight completion-fence state machine.

### 2.2 Layout/Placement: DOM rectangle ↔ native bounds (`view-anchor`)

This independent package keeps a main-process native view aligned with a DOM element's screen rectangle. It measures `getBoundingClientRect()` and passes the rectangle to an injected `publish` sink (host IPC → `setBounds`). ResizeObserver and window resize synchronously republish rather than adding a RAF delay; native setBounds already lags a frame, and another frame causes visible splitter-drag lag. See the detailed comments in `view-anchor/src/view-anchor.ts`.

**Explicit `Placement{visible}`:** visibility is a discriminant, never inferred from geometry. A present geometric box laid out at 0×0 can be `{ visible:true, bounds:{...width:0} }`; a hidden or absent box (`display:none`, unmounted) is `{ visible:false }`, without bounds. This replaces the old ambiguous convention where `{0,0,0,0}` meant hidden.

> `display:none` or no geometric box must publish `{ visible:false }` to detach, not a zero-sized visible placement. `{ visible:true, bounds:0×0 }` is reserved for a box genuinely laid out at zero area. `visible:false` comes from either caller hide intent or the anchor's observation of an absent box; measurement reports facts without rewriting intent. Box with zero area → visible with 0×0; no box → hidden. See `contracts/view-anchor-following.md` section 3.

**Reverse size anchor:** forward anchoring makes the native view follow DOM; reverse anchoring makes a DOM slot follow content size measured as border-box in the downstream view's renderer. Single-axis ownership (block = height, inline = width) keeps cross-process feedback as a one-way DAG.

- Files: `view-anchor/src/types.ts` for Placement, `view-anchor.ts` for forward and explicit-placement logic, and `size-anchor.ts` for reverse sizing.

### 2.3 Compositor: per-window native z-order

Compositor plans native child-view ordering inside one window. It separates **intent** (mount/unmount/reorder at a zone-relative position) from **application** (`commit()` computes a minimum add/remove sequence from current host children to the target).

The total order is **`(zone, orderKey, viewId)`**. Lower zones render beneath higher zones; orderKey orders views within a zone, and viewId makes ties deterministic. orderKey uses fractional indexing: reorder-before(X) chooses the midpoint between X and its predecessor, in O(1) without changing other keys. If midpoint precision runs out, rebalance the whole zone without changing visible order.

**Prefix-preserving commit** reduces a batch of intents to its final target state rather than replaying a log, then diffs host children against that target. Since the host can only append/raise with addChildView, preserve the longest target prefix whose current indices increase. Remove and add the remaining shared views and new views in one synchronous pass, with **no renderer reload**.

> A prefix is not an LIS, so this does not guarantee minimum host churn. `computeKeepIds` stops at the first out-of-order element in `src/main/compositor.ts`. For current `[A,B,C]` and target `[C,A,B]`, the prefix keeps `{C}` and requires two additions; an LIS keeps `{A,B}` and needs one. This is a deliberate simplification for append-to-top primitives. Churn is bounded by the number of shared views; addChildView raises an already-mounted child without reloading it.

This main-process native z layer follows from Electron's composition constraint and is outside dockview's DOM responsibilities.

- File: `src/main/compositor.ts` defines Compositor, reorder/fractional keys (including `keyBefore`), and prefix-preserving commit. `compositor.test.ts` verifies host call sequences.

### 2.4 ControlBus: a small IPC/trust interface

ControlBus exposes three operations without adding new admission checks itself:

- `command(name, handler)`: webview → main RPC. ControlBus owns the command table, and the real WireTransport's `invokeHost` calls `dispatch(name, args)` after sender and main-frame gates. All trust/main-frame validation belongs to the wire.
- `event(name)`: main → webview push, denied by default. Register name in the declared-event allowlist read by the wire; the wire drops undeclared names.
- `trust(wc)`: delegate to an injectable reference-counted TrustSet.

ControlBus's command table is its sole command authority. Hosts using it assemble WireTransport in `backend.assemble` with `invokeHost = (n,a) => controlBus.dispatch(n,a)`, so real IPC reaches handlers through the wire. deck-app does not wire ControlBus automatically. Its declarative `hostServices` use a separate IPC registry without a grant gate, not the ControlBus command table.

> 🔒 **Layout/privileged commands must go through ControlBus.** `ControlBus.dispatch` is the only grant-gating point. Actions such as `layout.resize`, `layout.reorder`, `layout.popout`, and `layout.overlay`, which drive native views, lifetime, or migration, must register and dispatch through ControlBus, never ordinary hostServices or InMemoryTypedIpcRegistry. Those routes check trust but not grants, so a misplaced privileged name bypasses authorization. See `contracts/capability-and-lifecycle.md` for routing and enforcement details.

- Files: `src/host/control-bus.ts` defines ControlBus and dispatch wiring; `src/internal/wire-transport.ts` provides the real trust/main-frame wire; `src/internal/trust-set.ts` separates read-only `TrustIndex{isTrusted/snapshot}` from `TrustSet`'s sole writer, `admit(wc, owner)`, whose reference-count decrement Disposable belongs to the owner Scope.

### 2.5 ViewHandle: per-view orchestration

ViewHandle combines the primitives for one view. It holds the native view, a scope lease identifying lifetime ownership, and a compositor token identifying its window's z stack.

- It does not calculate layout; Layout/Placement supplies geometry.
- It does not choose release policy; Scope owns lifetime and the handle holds a lease.
- It does not hold a global tree; cross-window/global orchestration belongs to runtime.
- It does not manipulate contentView directly; addChildView/removeChildView go through Compositor.

`runtime.view(...)` returns `DeckViewHandle` with `placeIn(window, {zone, anchor})`, `applyPlacement({visible, bounds})`, `moveTo(window, {rehome})`, and `dispose()`, plus read-only `webContents`, `bounds()`, and `capturePage()`. Hosts need not diff contentView.children to find the native view. placeIn/moveTo accept either DeckWindow or a raw BrowserWindow.

---

## 3. Six architectural decisions

| #   | Decision                                                               | Reason                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Mixed composition needs a main-process native z layer (Compositor)** | WebContentsView and renderer DOM do not share a layout tree. Main alone controls native child order in overlapping regions. compositor.test.ts verifies these calls.                                                                                                                                                         |
| 2   | **Separate authorities**                                               | Renderer control owns DOM split/grid/tab layout (dockview or CSS); main owns cross-window native views and lifecycle. Each is authoritative for its domain without mirroring the other's state.                                                                                                                              |
| 3   | **No split primitive in the host-shell main process**                  | Renderer owns DOM splits. The framework makes native views follow arbitrary slots through view-anchor and orders them through Compositor. Supporting splits here means following splitter movement, complementing dockview rather than replacing it. view-anchor is the cross-process counterpart of OverlayRenderContainer. |
| 4   | **Placement differs from lifetime**                                    | A view's displayed window and lifetime scope are independent. moveTo changes placement by default. Explicit `moveTo(dest, { rehome: true })` uses Scope.adopt when lifetime must outlive the old session; moving a panel must not accidentally change release ownership.                                                     |
| 5   | **Popout is live migration**                                           | moveTo transfers the token and same native reference between Compositors without creating a new WebContentsView. rehome transfers lifetime through adopt. The state machine attaches to only one window at a time and rolls back to src on destination failure.                                                              |
| 6   | **Small, domain-neutral host API**                                     | Hosts use `runtime.windows.create → Window`, `runtime.view().placeIn / moveTo`, `window.onClose`, and restricted `window.compositor` reorder/commit/batch. The goal is a minimal host of roughly 30 lines; see docs/layout-architecture-demo.md.                                                                             |

---

## 4. Host-facing API and minimal host example

> `examples/layout-demo/` provides a runnable version with real-device offscreen verification. This sketch connects the primitives and decisions in sections 2–3. `runtime.windows.create()` and `runtime.windows.main` return DeckWindow `{ window, controlWc, newSession(), onClose() }`, letting the framework own lifetime-tree/compositor/trust wiring. `newSession()` creates a window-rooted DeckSession, shorter-lived than the window. `runtime.view({ scope })` accepts only these sessions, validates provenance, and rejects raw Scope instances.

```ts
import { electronDeck } from 'electron-deck'

const Z = { CONTENT: 0, PANEL: 10, OVERLAY: 100 } // Compositor z zones

electronDeck({
	app: { source: { url: 'app://project-shell' } }, // The framework creates and automatically loads the main window.
	backend: {
		async assemble(runtime) {
			const main = runtime.windows.main // DeckWindow for the framework-created main window

			let session = null
			function openProject(path) {
				session = main.newSession() // Window-rooted session: project close resets it while keeping the window alive.

				runtime
					.view({ source: previewSource(path), scope: session })
					.placeIn(main, { zone: Z.CONTENT, anchor: '#preview' }) // view-anchor connects geometry; accepts DeckWindow.
				runtime
					.view({ source: { panelFor: '#preview' }, scope: session })
					.placeIn(main, { zone: Z.PANEL, anchor: '#panel' })
			}

			main.onClose(async () => {
				// Requirement A: close returns to main through a cancellable per-window decision.
				if (session) {
					await session.reset() // Completion fence: continue only after resource cleanup finishes.
					session = null
					return 'keep' // Keep the window; the host emits navigation back to the project list.
				}
				return 'close'
			})

			function showOverlay(src, rect) {
				// Requirement C: overlay above native views = highest zone.
				return runtime
					.view({ source: src, scope: main.newSession() })
					.placeIn(main, { zone: Z.OVERLAY })
					.applyPlacement({ visible: true, bounds: rect })
			}

			// Requirement B: privileged control-layer layout authorization; `runtime.grants` was removed.
			// To authorize layout.* commands by window/session boundaries, hosts must wire
			// createCapabilityRegistry() and ControlBus from `electron-deck/host` themselves;
			// the runtime no longer provides this convenience wiring.
		},
	},
})
```

> **Security:** when a control wc begins main-frame cross-document navigation, the framework synchronously revokes all its slot tokens (`did-start-navigation`). The new document cannot inherit the old page's anchor authorization, while control-layer trust remains. Windows trusted later with windows.trust after `autoTrust:false` receive the same protection.

The control renderer draws DOM splits and empty slots for native views, then publishes layout intent through the IPC client:

```tsx
const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
// <div id="preview"/> and <div id="panel"/> are slots covered by native views from main.
// The client remeasures through view-anchor/ResizeObserver; native views follow without host resize code.
```

---

## 5. Primitive reference

| Primitive/API                 | Responsibility                                                                                                                                      | Files                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Scope**                     | Nested lifetime, completion fences, adopt                                                                                                           | `src/main/scope.ts`                                                                      |
| **Layout/Placement**          | DOM rect ↔ native bounds; explicit `Placement{visible}` discriminant                                                                                | `view-anchor/src/`                                                                       |
| **Compositor**                | Per-window native z-order, fractional indexing, prefix-preserving commit                                                                            | `src/main/compositor.ts`                                                                 |
| **ControlBus**                | Small IPC/trust API connected to real WireTransport                                                                                                 | `src/host/control-bus.ts`, `src/internal/wire-transport.ts`, `src/internal/trust-set.ts` |
| **ViewHandle / runtime.view** | Per-view placeIn/applyPlacement/moveTo and bounds/capturePage/webContents                                                                           | `src/main/view-handle.ts`, `src/internal/deck-app.ts`                                    |
| **Capability/grants**         | Grant gating, senderId propagation, per-wc Scope, navigation revocation                                                                             | `src/host/capability.ts`, `src/internal/deck-app.ts`                                     |
| **Layout client**             | `createDeckLayoutClient({bridge})`; central publisher coalesces window snapshots/subscription with slot-token authorization and main reconciliation | `src/client/layout-client.ts`, `src/layout/snapshot-reconcile.ts`, `src/preload/`        |
| **Window API**                | `runtime.windows.create()/.main` → `DeckWindow{window,controlWc,newSession(),onClose()}`                                                            | `src/internal/deck-app.ts`                                                               |

Detailed cross-cutting contracts live in `contracts/`: anchor following in `view-anchor-following.md`, transactional commit/teardown in `compositor-and-teardown.md`, capability/lifecycle in `capability-and-lifecycle.md`, and unified lifetime in `unified-lifetime.md`.

---

## 6. Key file index

| Path                               | Contents                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/layout/`                      | Pure TypeScript layout-as-data: types.ts trees/nodes/registry/model; mutations.ts pure tree transformations; serialize.ts round trips and collectTreeProblems; model.ts single-writer observable model; registry.ts panels; index.ts exports |
| `src/dock-react/`                  | dock-view.tsx React DockView renderer and drag-redock.ts pure drag geometry; index.ts exports                                                                                                                                                |
| `src/main/scope.ts`                | own/child/reset/close/on/adopt and shared in-flight completion-fence state machine                                                                                                                                                           |
| `src/main/compositor.ts`           | Total (zone,orderKey,viewId) order, fractional indexing, prefix-preserving commit                                                                                                                                                            |
| `src/host/control-bus.ts`          | command/event/trust/dispatch/declaredEvents                                                                                                                                                                                                  |
| `src/internal/wire-transport.ts`   | Real Electron ipcMain.handle routing, trust/main-frame gates, event fanout                                                                                                                                                                   |
| `src/internal/trust-set.ts`        | Read-only TrustIndex isTrusted/snapshot and sole admission writer admit(wc, owner)                                                                                                                                                           |
| `src/internal/deck-app.ts`         | electronDeck app, whenReady gating, window assembly, close decisions, shutdown order                                                                                                                                                         |
| `view-anchor/src/types.ts`         | Bounds, Placement, and forward/reverse anchor type contracts                                                                                                                                                                                 |
| `view-anchor/src/view-anchor.ts`   | Forward anchor and explicit Placement logic                                                                                                                                                                                                  |
| `view-anchor/src/size-anchor.ts`   | Reverse size flow from downstream content to host slots                                                                                                                                                                                      |
| `docs/layout-architecture-demo.md` | Full minimal host example from section 4                                                                                                                                                                                                     |
| `docs/foundation.md`               | Connection, Disposable, and Scope foundation                                                                                                                                                                                                 |
| `docs/contracts/`                  | Following, commit/teardown, capability, and unified-lifetime contracts                                                                                                                                                                       |
