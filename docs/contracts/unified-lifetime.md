# Unified lifetime and trust foundation contract

This document defines the shared foundation for lifetime and trust: the Scope tree, sibling wcScope/viewScope topology, when wcScope is created, Scope-owned trust writes, coexistence of Connection and wcScope, generation-bound grants, `WindowRecord`/`WcRecord` data structures, and the control-loss decision. ViewHandle, capability grants, and tab keep-alive all depend on this foundation: **every control wc has a Scope that becomes `closed` when that wc is destroyed**.

Key files: `deck-app.ts` (window creation, trust, shutdown, and runtime factory), `trust-set.ts` (trusted membership), `connection.ts` (per-wc `Connection` / `ConnectionRegistry`), `scope.ts` (nested lifetimes, completion fences, and LIFO), and `control-bus.ts` (`command/event/trust` facade). Companion contracts: `compositor-and-teardown.md` (per-window teardown and `own()` LIFO) and `capability-and-lifecycle.md` (grant gates, slotToken, and keep-alive).

---

## 0. One set of lifetime semantics

Lifetime and trust converge on **one set of `Scope` semantics**: nesting, completion fences, and LIFO. This is the only available primitive that can express the nested “window ⊃ wc ⊃ view ⊃ session” relationship. Otherwise, window lifetime, trust membership, and connection-segment lifetime become parallel sources maintained separately. Closing a window, navigating, or quitting must update all of them correctly; missing any one causes a leak or use-after-free.

Overall decisions:

- **Unified records have two levels: windows and trusted wc**. Each window has a `WindowRecord{ windowScope }`; each trusted wc has a `WcRecord{ wcScope, leases: Set<Lease> }` **under that window's windowScope**. A global `Map<WebContents, WcRecord>` uses **wc object identity** as its key (§8). Structurally, windowScope supports multiple sibling wcScopes (multiple wc per window), but current framework code admits only the window's own control wc (`win.webContents`) once. No other code path creates a second distinct wcScope under the same windowScope. `WcRecord.leases` is a Set because **the same wc** can be admitted repeatedly (framework auto-trust at creation plus later explicit host `runtime.windows.trust()`), not because a window has multiple wc.
- **trustSet remains** the underlying membership table for `isTrusted` / fanout. However, **the lifetime of its writes**—admission and removal—is managed by wcScope `own()`, rather than manual insertion/deletion.
- **Connection and wcScope coexist**. `Connection` (`connection.ts`) is a published `electron-deck/main` API: a flat per-wc registry whose `acquire(wc)` returns a webContents-bound segment-lifetime facade, widely used by downstream hosts. wcScope is the framework's nested lifetime primitive (§1). Both are per-wc lifetime mechanisms: Connection is flat, keyed by `wc.id`, and automatically closes through `wc.once('destroyed')`; wcScope is nested and cascades with windowScope (§5).

---

## 1. Unified Scope tree

### 1.1 ASCII tree

```
rootScope                       ← process-level (app lifetime); held by deck-app; close() on quit
│  own: app-level wire / ipcMain handlers, remaining app-level registry resources,
│       the framework-owned share of trustSet membership (see §4)
│
├── windowScope (main window)    ← one WindowRecord.windowScope per BrowserWindow
│   │  own: () => win.destroy()  (teardown contract: own first ⇒ LIFO runs last)
│   │
│   ├── wcScope (main control renderer)─┐ ← win.webContents lifetime; WcRecord{ wcScope, leases }
│   │   │                              │   sibling of viewScope
│   │   │  own: leases (Set)            │   (different webContents; sibling argument in §2)
│   │   │  own: () => wire.dispose()    │   (teardown contract)
│   │   │  on('reset'|'closed')         │ ← grants bound here revoke automatically (§7)
│   │   │
│   │   └── (navigation soft reuse = wcScope.reset(): new segment, same object, generation++)
│   │
│   ├── viewScope*  ────────────────────  ← one per native WebContentsView (possibly many)
│   │   │                                  sibling of wcScope (independent webContents)
│   │   │  own: () => compositor.detach(viewId) (teardown contract)
│   │   │  own: () => anchorSink.dispose() (teardown contract: own last ⇒ run first)
│   │   │  own: retained nativeView / keep-alive WebContents
│   │   │       (capability contract: Scope owns lifetime; host owns eviction policy)
│   │   └── closes with windowScope.close, or independently to close one view
│   │
│   └── sessionScope*  ─────────────────  ← project sessions (= main.scope.child in layout demo)
│       │  own: session-lifetime resources (per-app-session bindings)
│       └── close project = sessionScope.close(); switch project = reset()
│
└── windowScope (popout window)  ← popout / declared window; same structure
    └── wcScope / viewScope* / sessionScope* … (independent subtree; always one wcScope per window)
```

Each windowScope currently has **one** wcScope for its own control wc; viewScope* are siblings at the same level (potentially multiple native views). `WcRecord` is separate from `WindowRecord` and lives under windowScope. The structure permits a second sibling wcScope in the future, but no current code path creates a second distinct wc for one window.

**Note**: the diagram places viewScope directly under windowScope, as wcScope's sibling. A view belonging to a session may instead live under `sessionScope`: the host chooses `windowScope.child()` or `sessionScope.child()` during assembly. **The host chooses the tree structure by selecting the parent Scope**; the framework only guarantees “parent close → cascade to children.”

### 1.2 Alignment with companion contracts

- The teardown contract's **window-scope is this document's windowScope**. Its `own()` LIFO encoding (`win.destroy()` registered first, anchor sink disposal last) applies across windowScope and viewScope; this document reuses that contract without redefining it.
- The capability contract's **“Scope of the control wc” is wcScope**. A grant binding `senderScope` to wcScope can reuse `on('reset'|'closed')` for automatic revocation (§7). Its concern about parallel per-wc Scope and trustSet+trackedWindows mechanisms is resolved by the convergence in §3/§4.

---

## 2. Why wcScope and viewScope are siblings, not parent and child

wcScope (control-renderer lifetime) and viewScope (native-view lifetime) are **siblings** under windowScope; neither is the other's parent:

1. **Different webContents, independent destruction**. The control renderer is one webContents (`win.webContents`); each native view has another (`WebContentsView.webContents`). Destroying one does not imply destroying the other. A native view can close while the control renderer remains alive (`unmount` in compositor-and-teardown.md); the control renderer can navigate (wcScope.reset) without changing native views. If `viewScope = wcScope.child()`, **wcScope.reset() would cascade teardown to all views**: reset disposes the current segment, including child scopes (`scope.ts` disposeSegment is children-first). That contradicts “navigation does not recreate native views.”
2. **Both die with the window through a shared parent**. Closing the window destroys both because **they share windowScope**, whose close cascades to both siblings in LIFO order (`scope.ts`), **not** because one is the other's parent. A common parent expresses a shared window lifetime; sibling scopes express independence from each other.
3. **Lifetime events do not interfere**. Grants bind to wcScope (the control renderer's generation); native-view anchor sinks bind to viewScope. A parent-child relation would let wcScope reset incorrectly trigger viewScope teardown, or vice versa, so navigation would revoke grants and also destroy views. Sibling topology keeps the two generation sequences **independent**.

> **Counterexample check**: does a dependency require views to die before wc, forcing a parent-child relation? No. Native-view detach needs a live `win.contentView`, and windowScope holds win until both siblings are torn down. **LIFO registration order within windowScope** guarantees detach before win destruction (teardown contract); viewScope need not be wcScope's child to impose that order. Sibling topology plus windowScope LIFO is sufficient.

---

## 3. When per-wc Scope (wcScope) is created

Create wcScope **when the window system admits/trusts the wc, not when a view is created**. The rationale and exact creation points follow.

### 3.1 Why creation cannot wait for a view

A control renderer can hold grants and invoke privileged commands **without any native views**. It controls layout; views are objects it places, not a prerequisite for its existence. Waiting for the first view would leave a viewless control renderer with no wcScope: nowhere to bind grants, no Scope to close on window shutdown, and no Scope owning trust. This is a **security gap**: the capability contract's wc.id-reuse safety depends on the grant's Scope becoming closed when wc is destroyed. Without wcScope, that guarantee is absent.

### 3.2 Exact creation point: trust admission

Create wcScope **at the same point where the framework decides to trust wc**—every existing call site of `_trustWebContents(wc)`:

| Existing trust point            | Location                                                | wcScope creation at the same point                                                      |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Main-window auto-trust          | `deck-app.ts` `_trustWebContentsLike(main.webContents)` | Main window's windowScope.child() = wcScope; trustLease = wcScope.own(trustSet.add(wc)) |
| Declared / runtime window trust | `deck-app.ts` `constructWindow(...autoTrust)`           | Create windowScope + wcScope for each declared/runtime window                           |
| `runtime.windows.trust(win)`    | `deck-app.ts` / control-bus `trust(wc)`                 | Create or retrieve wcScope when the host explicitly trusts wc                           |

**Decision: “trust ⟺ wcScope exists” is an invariant**. A wc enters trusted membership **if and only if** it has a live wcScope, which owns its trustLease. This combines membership and lifetime, eliminating parallel trustSet/lifetime management (§4).

> **Current behavior**: control-bus `trust(wc, owner)` (`control-bus.ts`) delegates directly to `trustSet.admit(wc, owner)`. The caller—the host using this layer in its `backend.assemble`—provides `owner` explicitly; deck-app neither derives nor manages it. Deck-app's own trust points (the §3.2 table) use its own trustSet, independently of whether a host assembles ControlBus. See §4.5.

---

## 4. Scope-owned trust writes

### 4.1 Two sources of trust writes

- **Framework auto-trust**: window assembly trusts its control wc (main / declared / runtime windows).
- **Explicit host trust**: through `runtime.windows.trust` / `ControlBus.trust(wc)`.

Both use the sole write entry point, `trustSet.admit(wc, owner)` (§4.5). Multiple leases can increment the refcount for the same wc.

### 4.2 wcScope owns trustLease; closing only needs wcScope.close()

```ts
// When creating wcScope (every trust point in §3.2):
const trustLease = trustSet.admit(wc, wcScope) // refcount++; wcScope owns the lease's refcount--
```

- **Write**: `admit` increments trustSet's refcount. trustSet remains the `isTrusted`/fanout membership table; wcScope `own()` manages the returned refcount-decrementing Disposable.
- **Removal**: there is no manual delete entry point. `wcScope.close()` (cascaded on window close, §6) runs all owned disposers in LIFO order, including the lease: `refcount--` → zero → internal trustSet `refs.delete(wc)`.

### 4.3 Why window-death cleanup is equivalent and stronger

Trust must disappear when a window dies: membership is no longer needed, and wc.id-reuse safety requires `isTrusted` to become false after close. wcScope.close's LIFO handles this without an “erase regardless of refcount” exception, because **no lease exists without wcScope ownership**. Framework-owned leases and host `windows.trust` leases all belong to **the same wcScope** (§3.2).

- One `wcScope.close()` disposes all that wc's leases in LIFO order → zero refcount → `refs.delete`.
- **Stronger**: every lease Disposable actually runs, rather than merely deleting a map key, so lease holders cannot mistakenly think their trust remains active.
- **wc.id-reuse safety**: refs no longer contains that wc after close. A new window receiving the same wc.id gets false from `isTrusted` (trust-set scans live keys by `.id`). It also gets a **new wcScope** (new generation, §7), without inheriting grants.

### 4.4 How senderPolicy.isTrusted reads from the Scope tree

`isTrusted(id)` reads `trustSet`, the authoritative membership table. The Scope tree only controls **the lifetime of writes to that table**:

- `wireSenderPolicy.isTrusted(id)` → `trustSet.isTrusted(id)`; the read path is unchanged.
- The relationship is **indirect**: live wcScope ⟺ live owned trustLease ⟺ wc present in trustSet ⟺ `isTrusted` true. wcScope.close ⟹ lease disposal ⟹ removal from trustSet ⟹ `isTrusted` false. **The Scope tree governs trust lifetime; trustSet is its query index**. Reads and writes are separate; neither replaces the other.

The first `isTrusted` gate in trust → main-frame → grant (`capability-and-lifecycle.md`) reads as before; wcScope lifetime determines when trust ends.

### 4.5 Restricting trust writes: read-only TrustIndex and admit-only writer

Separate trust reads and writes to prevent direct writes that bypass wcScope.own. Code review alone cannot reliably prevent such unowned leases: an unowned lease has no Scope-managed disposal, leaving an immortal refcount, breaking §4.3 equivalence and creating a security gap.

```ts
/** Read-only query index, with no write entry points. */
export interface TrustIndex {
	isTrusted(id: number): boolean
	snapshot(): readonly MinimalWebContents[]
}

/** Writable trust set with admit as the only entry point, requiring an owner Scope.
 *  The owner owns the lease's refcount decrement; admission and lifetime ownership
 *  occur together, so no unowned lease can be produced. */
export interface TrustSet extends TrustIndex {
	admit(wc: MinimalWebContents, owner: Scope): Disposable
}
```

- **`admit(wc, owner)` is the only write entry point** (`trust-set.ts`), requiring an owner Scope. `owner` manages the lease's refcount decrement; callers cannot obtain an unowned raw lease. Every §3.2 trust point uses `admit(wc, wcScope)`. `ControlBus.trust(wc, owner)` receives `owner` directly from its caller, without deck-app deriving it: ControlBus is an independent utility that deck-app does not wire automatically.
- **No public `add` / `deleteEntry` write entry points**. wcScope owns every lease; one `wcScope.close()` brings refcount to zero in LIFO order (§4.3). This is equivalent to the old immediate erase on window death and **stronger**, because every lease disposer runs. No refcount-bypassing escape hatch is needed.

---

## 5. Connection and wcScope

### 5.1 Connection is a published API

`electron-deck/main` exports `createConnectionRegistry` / `Connection` / `ConnectionRegistry` (`src/main/index.ts`). Host main processes use them to assign resources to webContents and cascade cleanup when webContents dies. Typical usage is `connections.acquire(wc).own(...)`, plus `connections.reset(wc.id)` on soft reuse to clean session-lifetime resources before pool return.

Its **`own()` versus `on('reset'|'closed')` semantics are deliberate** (foundation.md §3): session-lifetime resources use `own()` (both reset and close clean them); wc-lifetime resources use `on('closed')` (survive sessions and revoke only on actual wc destruction, such as wiring for “open in an external editor”). Production consumers depend on these semantics.

### 5.2 Relationship between Connection and Scope

Connection is a flat per-wc registry; wcScope is a nested lifetime primitive:

| Dimension            | Connection                                                                              | Scope                                                                           | More general                                    |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Nesting              | ❌ Flat (foundation.md: no nesting)                                                     | ✅ child/adopt                                                                  | **Scope**                                       |
| Segment-lifetime own | ✅                                                                                      | ✅                                                                              | Equal                                           |
| reset/close          | ✅ Synchronous segment switch; events emit when disposeAll **starts** (`connection.ts`) | ✅ **Completion fence**: events emit after disposeAll **finishes** (`scope.ts`) | **Scope**: stronger, waits for complete cleanup |
| Key                  | `wc.id` (registry maintains a Map)                                                      | No key (bare lifetime segment)                                                  | Connection adds wc-keying                       |
| Terminal hook        | Automatically closes through `wc.once('destroyed')`                                     | None (owner closes explicitly)                                                  | Connection adds wc binding                      |

Connection is approximately a flat registry bound to webContents: webContents-bound segment lifetime plus an id-indexed registry. wcScope is a nested lifetime primitive. They coexist: Connection indexes by `wc.id` and automatically closes on `wc.once('destroyed')`; wcScope cascades with windowScope (§6) and uses completion-fence events.

### 5.3 Choosing between them

| Scenario                                                          | Use          | Reason                                                                                               |
| ----------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Resource lifetime equals a webContents lifetime                   | `Connection` | Automatic `wc.once('destroyed')` close; no custom hook needed; `get(wc.id)` retrieves it by id       |
| A webContents is reused by another consumer (pooling)             | `Connection` | `reset(id)` switches segments synchronously, cleans old resources, and retains the connection object |
| Parent-child nesting or moving a child lifetime to another parent | `Scope`      | Connection is flat, without child/adopt                                                              |
| Listeners must act only after cleanup is complete                 | `Scope`      | Scope events are completion fences; Connection events emit when `disposeAll()` **starts**            |
| Lifetime is not associated with webContents                       | `Scope`      | Connection requires a wc for `acquire`                                                               |

**These express two different semantics, rather than redundant historical APIs.** All package-internal code uses `Scope` (deck-app / view-handle / trust-set / control-bus / capability). `Connection` is the published host API and **has no internal call sites by design; that does not make it dead code**. The same applies to `debugTap`. Check downstream consumers before changing or deleting them.

---

## 6. Three teardown paths share one mechanism

Closing a popout, closing the main window, and quitting the process **all cascade through Scope.close()**:

```
Close popout:      its windowScope.close()
                   → LIFO: viewScope*.close → wcScope.close (trustLease release, §4)
                           → sessionScope*.close → win.destroy() last (teardown contract)
                   (rootScope and other windows unchanged)

Close main:        main windowScope.close() (same order)
                   → deck-app app-level shutdown if configured so main-window death exits app

Process quit:      rootScope.close()
                   → LIFO cascade through all windowScopes (each uses per-window order above)
                   → app-level wire/registry owned directly by rootScope last
```

### 6.1 rootScope registration order ensures windows precede registry

Shutdown uses `rootScope.close()`. WireTransport / app-level registry resources live in the registry; disposing it while windows remain alive lets renderer teardown handlers call removed ipcMain handlers. **rootScope ownership registration** encodes the required “windows before registry” order:

```ts
// Assemble rootScope (registration order reverses LIFO execution order):
rootScope.own(() => appLevelRegistry.disposeAll()) // own first ⇒ run last (app registry last)
// Each windowScope = rootScope.child(), a child in the rootScope segment.
// Children-before-resources LIFO tears down all windowScopes before the app registry.
```

- `compositor-and-teardown.md` encodes the **within-window** order (anchor dispose → detach → wire dispose → win.destroy) with windowScope own LIFO. This document adds the **cross-window and app-level** order: rootScope's children (all windowScopes) precede resources (app registry), preserving “windows before registry” alongside each window's internal order.
- `backend.onShutdown()` must run **before any teardown**: it is the host's save hook. It therefore does not belong in rootScope.own, which contains LIFO teardown operations. Await it **before** `await rootScope.close()`: `doShutdown = await backend.onShutdown() → await rootScope.close() → app.quit()`.

> **onShutdown placement**: this host save hook must run **before any teardown**. Do not register it in rootScope.own. The **caller** of `rootScope.close()` awaits it **before** `await rootScope.close()`: `doShutdown = await backend.onShutdown() → await rootScope.close() → app.quit()`. The framework applies **no timeout** to this await; hosts requiring a limit implement it with `Promise.race` themselves.

### 6.2 quit and will-quit reentry protection remains

The `deck-app.ts` `quitInitiated` guard remains **unchanged**: shutdown driven by will-quit must not call `app.quit()` again. This is an app/process concern independent of Scope convergence. After rootScope.close completes, retain `if (!quitInitiated) app.quit()`.

### 6.3 Keep the keep/close decision state machine

The main-window close decision in `deck-app.ts`—preventDefault → ask backend keep/close → destroy only on close—**does not move into Scope**. It decides **whether** to close; Scope defines **how** teardown proceeds once closing. Only a 'close' decision triggers `windowScope.close()`. The decision sits above the Scope cascade.

---

## 7. Generation-bound grants

The capability contract's grant registry (`capability.ts`) is general-purpose: `issue(grant)` subscribes to `grant.senderScope` `on('reset'|'closed')` for automatic revocation. **The caller provides senderScope when constructing Grant**; the framework does not wire it automatically. `deck-app.ts` no longer has a `runtime.grants` convenience wrapper and does not fill a control wc's wcScope into Grant for the host.

- If the host binds Grant's `senderScope` to that wc's wcScope (§3 guarantees it exists iff wc is trusted), automatic revocation follows:
  - `off1 = wcScope.on('reset',  () => revoke(grant))`: navigation soft reuse invalidates the old authorization.
  - `off2 = wcScope.on('closed', () => revoke(grant))`: window destruction invalidates it.
- **Generations are not inherited** with that wiring: wc destruction → wcScope.close (§6) → off2 fires → revoke. A new window receiving the same wc.id creates a **new wcScope** at a new §3.2 trust point, with a **new generation**. The old grant is already revoked; the new wcScope has none of the old grants.
- **The current framework does not provide this wiring**. `deck-app.ts` exposes no public wcScope handle for any wc. To obtain this wc.id-reuse safety, hosts must bind Grant's `senderScope` to a Scope synchronized with that wc's lifetime. The `capability.ts` registry only guarantees “senderScope dies → grant revokes”; it does not choose what senderScope represents.

> The reset/close events subscribed to by grants are events of **Scope itself**, with completion-fence semantics (`scope.ts`), **not** Connection's start-of-disposal events (§5). Revoke only synchronously removes a grant from the active policy set and does not require complete resource cleanup, so either timing is safe. Scope events are the more direct binding: grants represent lifetime, rather than Connection session segments.

### 7.1 Control-loss policy: cascade close to windowScope

**Problem**: if the control wc is destroyed through a crash / `render-process-gone`, **rather than** normal navigation or window close, what should happen to its **sibling** viewScopes (native views in the same window, §2)? Two options:

- **(A) Freeze viewScope**: retain last bounds, reject new layout commands, and resume after rebuilding the control layer with new-generation replay.
- **(B) Close windowScope as well**: loss of control triggers windowScope.close, cascading to viewScope.

**Decision: (B), close windowScope as well.** Rationale:

1. **Sibling topology expresses independent destruction, not survival after the other sibling dies**. viewScope has no independent control source: **all** bounds/layout arrive from control-renderer commands. Losing control leaves it unmanaged. (A)'s freeze-and-replay needs a **generation replay protocol**: who stores the last command, how new control claims old views, and how bounds drift is reconciled. This contract **has no such protocol**, and it is outside the foundation's scope. Freezing without one leaves a zombie view attached to a dead control layer, permanently rejecting new commands.
2. **Consistent with §3.1's control-renderer prerequisite**: views are what the control layer places; control is a prerequisite for views. When it disappears, its views are torn down as well.
3. **Crash recovery rebuilds the window** with a new windowScope, wcScope, and generation, rather than reviving old views in place. This matches §7's new wcScope on wc.id reuse without inherited generations. There is one full-window rebuild path, without a special case that preserves a partly dead window.

**Trigger (decision, not yet implemented)**: `connection.ts` currently only listens to `wc.once('destroyed')` for hard destruction. To cover **crashes**, listen to `render-process-gone` on the control wc's webContents and call its window's `windowScope.close()`—the same cascade as normal close (§6). **Production code currently has no such listener**. The repository's only `render-process-gone` listener is in `src/main/overlay-panel.ts`; it handles the broken overlay view itself, not this windowScope cascade, so it does not establish that this decision is implemented.

> **Distinction**: `destroyed` is wcScope's own terminal hook. `render-process-gone` means **control-layer crash**, which must escalate to **windowScope.close** (tear down the whole window), rather than merely close wcScope. Closing only wcScope leaves frozen sibling viewScopes: option (A)'s rejected zombie state.

> **Scope**: this decision concerns the window's own control wc (`win.webContents`), the renderer driving its layout. Current framework windows have only that one trusted wc, with no non-primary control wc to discuss. If a second trusted wc is added in the future, whether its crash closes the window requires a separate decision.

---

## 8. Unified WindowRecord: a shadow map of trackedWindows

### 8.1 TypeScript data structures

Two levels: one `WindowRecord{ windowScope }` per window and one `WcRecord{ wcScope, leases: Set<Lease> }` per trusted wc, containing multiple leases. A global `Map<WebContents, WcRecord>` indexes all trusted wc by object identity. Each current window trusts only its own control wc.

```ts
/** One trust lease: a refcount-decrementing Disposable for one admission of wc,
 *  owned by its WcRecord's wcScope (§4.2). A wc may be trusted repeatedly
 *  (framework auto-trust plus host windows.trust), hence a Set of leases. */
type Lease = Disposable

/** One record per trusted webContents. Its wcScope is under its windowScope,
 *  sibling to viewScope (§2); currently one per window, for its control wc. */
interface WcRecord {
	/** This wc's lifetime: windowScope.child(), sibling to other wcScopes/viewScopes (§2).
	 *  Owns leases (§4) and wire disposal (teardown contract). Navigation soft reuse = wcScope.reset().
	 *  Grants binding senderScope here use on('reset'|'closed') (§7). */
	readonly wcScope: Scope
	/** All trust leases for this wc (≥1), owned by wcScope (§4.2). Window death =
	 *  wcScope.close → LIFO disposal of every lease → trustSet refcount zero and deletion
	 *  (equivalent to old deleteEntry, §4.3). Set, rather than singular, supports multiple
	 *  refcounts from framework auto-trust plus host windows.trust on the same wc. */
	readonly leases: Set<Lease>
}

/** One record per window. deck-app.ts still retains trackedWindows: Set<MinimalBrowserWindow>,
 *  required by existing code paths. This is a shadow map kept in lockstep, not a replacement.
 *  It does not hold wcScope directly: the window's wc are siblings under windowScope in WcRegistry. */
interface WindowRecord {
	/** Root lifetime for this window: rootScope.child(). close() tears down the whole window,
	 *  including all wcScopes/viewScopes (§6). Owns () => win.destroy(), registered first
	 *  to run last (teardown contract). */
	readonly windowScope: Scope
	// wcScope / viewScope* / sessionScope* are not WindowRecord fields:
	//   · wcScope: one WcRecord per trusted wc, indexed by WcRegistry below;
	//   · viewScope* / sessionScope*: windowScope.child()/sessionScope; creators retain handles.
	// WindowRecord defines only the one per-window lifetime: windowScope.
}

/** Global trusted wc → WcRecord index, keyed by wc object identity, not wc.id.
 *  Hosts and framework commonly use object identity for ownership (foundation.md:
 *  pass WebContents handles, not numbers). Multiple trusted wc in one window all
 *  live in this table, with each wcScope under that window's windowScope. */
type WcRegistry = Map<MinimalWebContents, WcRecord>

/** Window → WindowRecord, also keyed by wc object identity: its primary control wc is a natural key. */
type WindowRegistry = Map<MinimalWebContents, WindowRecord>
//   ↑ Shadow map kept in lockstep with trackedWindows: Set<MinimalBrowserWindow> (deck-app.ts), not a replacement
```

> **Key choice: MinimalWebContents or windowId?** Use **wc object identity**. (1) Framework and host already compare object identity extensively (`page.renderWc !== sender`, foundation.md). (2) wc.id can be reused (`trust-set.ts` concern); object identity cannot. (3) Connection registry also uses wc for acquisition (`acquire(wc)`). WcRegistry keys **every trusted wc** by identity; WindowRegistry keys the primary control wc of each window. Currently these are the same wc. In a multi-view window, native-view wc from viewScope **do not enter WcRegistry**: they are objects being positioned, held by viewScope handles, not trusted control renderers.

### 8.2 WindowRegistry usage

- Create window: insert `WindowRecord{ windowScope }` into WindowRegistry; at the same point, create a `WcRecord` for the control wc and insert it into WcRegistry.
- Close child window: `registry.delete(wc)` in windowScope.close's owned disposer / closed hook.
- Shutdown: `rootScope.close()` cascades through windowScopes, each owning win.destroy; do not iterate destroy calls.
- `runtime.windows.all()`: iterate `registry.values()` to obtain live windows.

---

## 9. Lifetime and trust authority mapping

| Concern                       | Lifetime authority                                                                                                                      | Query index                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Window lifetime**           | `WindowRegistry: Map<wc, WindowRecord{windowScope}>`; windowScope.close cascades through all wcScopes/viewScopes, then win.destroy last | —                                                |
| **Trust**                     | Each wc's `wcScope.own(lease)`, with leases in `WcRecord.leases`; wcScope.close → lease disposal → zero refcount                        | trustSet (`isTrusted`/fanout; read path in §4.4) |
| **Per-wc segment lifetime**   | Connection manages its own `DisposableRegistry` (§5)                                                                                    | ConnectionRegistry indexes by wc                 |
| **Nested lifetime semantics** | `Scope`: rootScope→windowScope→{wcScope, viewScope*, sessionScope*} (§1)                                                                | —                                                |

---

## 10. Assembly rules

- 🔒 **viewScope must belong to windowScope or sessionScope, not wcScope** (§2). `viewScope = wcScope.child()` would let navigation (wcScope.reset) destroy native views, violating “navigation does not recreate views.”
- 🔒 **No unowned trust leases**: writes only use `admit(wc, wcScope)` (§4.5), with wcScope owning the lease. Leaving one lease that is never disposed lets trustSet retain wc after wcScope.close; `isTrusted` incorrectly stays true, leaving a closed window's wc trusted.
- **Do not mix wc.id and object-identity keys**. WindowRegistry / WcRegistry use wc object identity (§8.1); wc.id can be reused, identity cannot. `isTrusted` / grants match wc.id. On reuse, the new window gets a new wcScope/record without inheritance (§4.3 + §7). Using wc.id for record keys would confuse reused identities.

### Interfaces with companion contracts

- **compositor-and-teardown.md**: windowScope / viewScope implement its window-scope; their own() LIFO encodes anchor dispose → detach → wire dispose → win.destroy. This document adds cross-window and app-level ordering through rootScope children-first (§6.1).
- **capability-and-lifecycle.md**: wcScope is its control-wc Scope; grants requiring wc.id-reuse safety must bind to it (§7). The isTrusted gate reads trustSet (§4.4).
