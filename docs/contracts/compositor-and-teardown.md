# Correctness contract: transactional Compositor commits and per-window teardown order

> Scope: two correctness contracts for the `electron-deck` main-process view orchestration layer. This document defines commit failure semantics, the `moveTo` cross-window migration state machine, the deadlock-free argument for `migrationLock`, the exact per-window teardown order, and its LIFO encoding with `Scope.own()`.
>
> Key files:
>
> - `src/main/compositor.ts` — `mount/unmount/reorder/commit/detachAll`, prefix-preserving diff, and `CommitError`
> - `src/main/view-handle.ts` — `moveTo` state machine and `migrationLock`
> - `src/main/scope.ts` — `own/close/adopt`, completion fence, and LIFO
> - `src/main/disposable.ts` — LIFO `DisposableRegistry.disposeAll()` and AggregateError
> - `src/internal/deck-app.ts` — **app-level** teardown: windows before the registry
>
> Baseline:
>
> - `commit()` is a **single synchronous pass**: first `removeChildView` for removals, then `addChildView` for additions in ascending target-index order. A destroyed host with **pending work** causes `CommitError`; a **no-op commit neither throws nor touches the host** (`compositor.ts`; pinned by `compositor.test.ts`).
> - The app-level teardown precedent is to **call `win.destroy()` on every window before `registry.disposeAll()`**. WireTransport belongs to the registry; disposing the registry while windows remain alive lets renderer teardown handlers send `__electron-deck:*` to removed `ipcMain` handlers. The per-window order refines this precedent at **single-window granularity**.

---

## 0. Terms and invariants

- **host**: a window's native `contentView` (`ContentViewHost`), with `addChildView`, `removeChildView`, `isDestroyed`, and `children()` (LAST = topmost).
- **commit pass**: the synchronous sequence of host add/remove calls within one `commit()` call.
- **native order**: the actual order in `host.children()`, the **only physical source of truth**. The Compositor's `views: Map` records **intent (the target)**; commit projects intent onto native state.
- **view instance identity**: `mount(id)` after `unmount(id)` creates a **new instance** (a new `mountSeq`, placed at the top of its zone), rather than extending the old instance's lifetime (`compositor.ts`).
- **window-scope**: one `Scope` per window (see §5), owning its anchor sink, wire, session, and native-view detach operation through `own()`. `close()` releases them in LIFO order.

Invariants (violations anywhere in this document are bugs):

- **I1 (native truth)**: after any commit path, `host.children()` must equal a consistent target: either the complete new target or the complete pre-commit snapshot after rollback. It must **never remain partially changed**.
- **I2 (single host per view)**: a view instance is attached to zero or one host at any time, **never to two hosts and never left dangling**. Migration permits a transient detached state protected by `migrationLock`.
- **I3 (no use-after-free during teardown)**: while a window-scope is being torn down, no still-running publisher, observer, or sink may call a host or window **whose destruction has started**.

---

# Transactional Compositor commits

## Problem

`commit()` calls `removeChildView` and `addChildView` one at a time in **one synchronous pass**. Electron **has no contentView transaction API**. If an `addChildView` throws midway through the pass—for example, because the target window is destroyed or concurrent teardown empties it—the host's `contentView` is only partly changed: all removals and some additions have run. **Throwing another exception cannot restore native order**. The caller receives an exception while native state is already an illegal intermediate state (violating I1).

Within **one synchronous pass**, there is no `await` between host calls. Commit only handles individual host calls throwing; it has no interval for concurrent changes during an `await`. The question is therefore: **how can a sequence of synchronous native calls, each of which may throw, provide all-or-nothing behavior or best-effort behavior with a clean rollback?**

## Commit failure semantics

The implementation first plans removals/additions, then checks `host.isDestroyed`. Removal-only work on a destroyed host completes silently; if there are additions, it throws `CommitError{kind:'host-destroyed', applied:false}` before touching the host. Before applying changes to a live host, it saves a `children()` snapshot. If any host call throws, it attempts to restore that snapshot and reports the result with `CommitError{kind:'apply-failed', applied:'partial', recovered}`.

### Exact commit failure semantics

The failure semantics of `commit()` are:

1. **Plan** (pure computation, without touching the host): fold intent into the target, then compute the `removals` / `additions` diff (`compositor.ts`).
2. **Empty check**: if both `removals` and `additions` are empty, **return immediately**. A no-op neither throws nor touches the host. **No-op commits during teardown must be silent** (see “Interaction with destroyed-host commit protection”).
3. **Preflight**: if there is work but `host.isDestroyed`, throw `CommitError{ kind:'host-destroyed', applied:false }` **before touching any host**. `applied:false` is a **strong guarantee**: native order equals the pre-commit snapshot, completely unchanged.
4. **Apply**: call `removeChildView` for every removal, then `addChildView` in ascending target-index order. **Save `snapshot = host.children()` before entering this phase**.
5. **Fallback rollback** (only when a native call unexpectedly throws during Apply—the narrow interval where the host is destroyed after planning, during apply): catch the exception, attempt to restore order from the snapshot, and, regardless of rollback success, throw `CommitError{ kind:'apply-failed', applied:'partial', recovered:boolean }`. `recovered:true` means native state equals the snapshot; `recovered:false` means native state is partially changed **and untrustworthy, so the caller must treat the host as dead** (see the source-also-destroyed branch under “Source destruction and ownership of view cleanup”).

```
CommitError =
  | { kind: 'host-destroyed'; applied: false }                         // preflight rejects; native state untouched
  | { kind: 'apply-failed'; applied: 'partial'; recovered: true }      // fallback rollback succeeded; native = snapshot
  | { kind: 'apply-failed'; applied: 'partial'; recovered: false }     // rollback also failed; native state untrustworthy → treat host as dead
```

> Design trade-off: **do not** introduce a return value `{applied, failed}` (option c). A successful commit returns `void` and leaves native state at the new target. A failed commit **throws** `CommitError`, whose fields describe the resulting native state. The call site (`moveTo`) can use try/catch without checking partial application after each call.

## Cross-window migration with moveTo

`moveTo` moves a view from the `src` window to the `dest` window. Physically, this requires **two commits on independent Compositors** (one host per window):

```
src.unmount(viewId);  src.commit();      // detach from source
dest.mount(viewRef);  dest.commit();     // attach to destination
```

The danger is **`dest.commit()` throwing** because the destination window is destroyed between the two commits. The view has already been detached from src but has not attached to dest: it is **dangling** (violating I2). A **clean rollback must reattach it to the source**.

### Commit guarantees needed for rollback

moveTo rollback depends on the commit failure semantics above providing these guarantees:

- If `dest.commit()` throws `host-destroyed` (`applied:false`), dest's **native state is completely untouched**. Rollback only needs to reattach at src; dest needs no cleanup. This follows directly from preflight (b): **dest destroyed → throw before touching dest's host → dest remains clean**.
- If `dest.commit()` throws `apply-failed; recovered:true`, dest's native state is back at its own pre-commit snapshot, which excludes the migrating view. This is also **equivalent to a clean dest**, so rollback reattaches at src as usual.
- If `dest.commit()` throws `apply-failed; recovered:false`, dest's native state is untrustworthy, so treat its host as dead. Rollback **must not and need not manage dest**: teardown will collect it, or destruction is already underway. Reattach at src as before.

> The key point is that **all three dest failures require exactly the same src rollback: reattach at src**. The only distinction is whether dest needs cleanup, and preflight plus snapshot rollback ensure that **moveTo need not clean up dest**. This is the benefit of (b) over (c): moveTo rollback is **independent of the specific dest failure kind**.

### moveTo transaction state machine

The view instance's final **physical location** must be one of **`AT_SRC` / `AT_DEST` / `CLOSED`** (the concrete form of I2). The state machine is:

```
                          moveTo(viewId, src → dest)
                                    │
                           [state: AT_SRC]   ← initially attached to src
                                    │
                  acquire migrationLock(viewId)         (see migrationLock section)
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ STEP 1: src.unmount(viewId); src.commit()      │
            └───────────────────────┬───────────────────────┘
              src.commit() throws?              src.commit() ok
              ──────────────                    ──────────────
                    │                                  │
         [state: AT_SRC]  ← source detach failed [state: DETACHED] ← lock-protected transient
         release lock; rethrow                  view has no host (I2 transient exception)
         (migration fails idempotently,                │
          without side effects)           ┌────────────┴────────────┐
                                          │ STEP 2: dest.mount(ref); │
                                          │         dest.commit()    │
                                          └────────────┬────────────┘
                                  dest.commit() throws?       dest.commit() ok
                                  ──────────────              ──────────────
                                        │                            │
                            ┌───────────┴──────────┐          [state: AT_DEST]
                            │ ROLLBACK: reattach   │          release lock
                            │ src.mount(ref)       │          ✔ migration succeeds
                            │ src.commit()         │
                            └───────────┬──────────┘
                          src reattach ok?      src reattach throws too?
                          ──────────            ──────────────
                                │                      │
                        [state: AT_SRC]        [state: CLOSED]
                        release lock           src also destroyed → close view
                        rethrow dest error     (dispose view instance and resources)
                        (clean rollback)       release lock; rethrow
                                               (no surviving home: destroy the view)
```

Exact steps in prose:

1. **Acquire** `migrationLock(viewId)` (see “Per-view migrationLock: serializing migration and close”). Entry state is `AT_SRC`.
2. **STEP 1**: `src.unmount(viewId); src.commit()`.
   - If it throws, remain `AT_SRC`: unmount only changes intent, and commit either leaves the host unchanged or preflight rejects before touching it. The view remains on src's native host. **Release the lock and rethrow**. Migration fails without side effects (idempotently).
   - If it succeeds, enter `DETACHED`: the view has no host, the lock-protected transient allowed by I2.
3. **STEP 2**: `dest.mount(viewRef); dest.commit()`.
   - If it succeeds, enter `AT_DEST`. **Release the lock** and return successfully.
   - If it throws, enter **ROLLBACK**.
4. **ROLLBACK**: `src.mount(viewRef); src.commit()`. Reattach the same ref at the source. Under `compositor.ts` semantics, this is a **new instance** at the top of src's zone. That is acceptable: failed migration does not promise to restore the old z-order, only to avoid a dangling or lost view.
   - If it succeeds, enter `AT_SRC`. **Release the lock** and rethrow dest's `CommitError`, telling the caller migration failed but the view is safely back at src.
   - If it throws because src is now also destroyed, enter `CLOSED`: **close the view instance**, disposing its view handle and releasing resources it owns in any window-scope. **Release the lock** and rethrow. The view has no surviving home, so destroy it; this is the only physically honest final state.

**Complete final-state coverage**: every path ends with the view physically in **exactly one** of `AT_SRC` / `AT_DEST` / `CLOSED`, never dangling or attached twice (I2). `migrationLock` serializes the entire operation. The hostless `DETACHED` transient **exists only while the lock is held** and is not observable externally.

## Source destruction and ownership of view cleanup

The `CLOSED` final state requires closing the view instance. This contract assigns **ownership of the view instance's resources to the window-scope of its current window** (see the per-window teardown order and the window-scope definition). During migration, the view's owned resources—its anchor sink, wire, and native-ref retention—move **from the src window-scope to the dest window-scope** with `AT_SRC→AT_DEST` through `Scope.adopt()`. In `scope.ts`, adopt does not reset or close the child or change its resources; it only changes cascade ownership. Thus:

- Successful migration (`AT_DEST`): resources are adopted into the dest window-scope and released in LIFO order when dest closes.
- Failed migration rolled back to `AT_SRC`: resources still belong to the src window-scope, because adoption has not happened or has been reversed.
- `CLOSED`: close the view's child scope directly and release its resources in LIFO order.

> Adopt's “wait for the fence without propagating its error” semantics (`scope.ts`) fit this model. If the src or dest window-scope is currently tearing down (an in-flight fence), adopt **waits for completion, then revalidates**. Failed revalidation rejects; moveTo treats that rejection as the destination disappearing and handles it in the dest-failure branch above.

## Per-view migrationLock: serializing migration and close

### Why a lock is needed

Dangerous concurrent pairs:

- `moveTo(v, A→B)` and `moveTo(v, B→A)`: the two unmount/mount sequences may interleave, attaching the view twice (both B's and A's mounts take effect) or detaching it twice and leaving it dangling, violating I2.
- `moveTo(v, A→B)` and `closeWindow(A)` (per-window teardown): teardown detaches the view while moveTo is in STEP 1, racing over native order.
- `moveTo(v, A→B)` and `closeWindow(B)`: STEP 2's `dest.commit()` and dest teardown's detach race over the host.

Lock granularity is **per view (`viewId`)**. Only one migration may be in flight for a view at a time; close paths involving that view must acquire the same lock (see the deadlock argument).

### Lock semantics

`migrationLock(viewId)` is a **per-view async mutex**:

- `acquire(viewId): Promise<release>` queues in FIFO order; enter the critical section only after acquisition.
- The critical section contains the entire moveTo, or the entire close operation's handling of that view.
- `release()` lets the next queued operation enter.

The implementation can reuse `Scope`'s single-flight fence approach (`scope.ts` serializes `inFlight`) or a minimal `Map<viewId, Promise>` chain. **Reentrancy is unnecessary**: moveTo never recursively acquires its own view's lock.

### Deadlock-free argument

Deadlock requires **circular waiting**: T1 holds L1 while waiting for L2, and T2 holds L2 while waiting for L1. This design prevents such cycles:

**Critical design constraint (the reason cycles cannot form)**: **each moveTo or close critical section holds only its own per-view lock and never acquires a second per-view lock while holding it**. Specifically:

- The complete `moveTo(v, …)` state machine (STEP1/STEP2/ROLLBACK) operates only on **view `v`**. Src/dest commits change host z-order but neither need nor acquire **another view's** migrationLock.
- `closeWindow(W)` teardown acquires `migrationLock(vᵢ)` for each window view **one at a time**, handles that view, and **immediately releases** it. It **never holds two locks simultaneously**. Closing a multi-view window is a **serial acquire-release-acquire-release** sequence, not “acquire all, then process.”

Therefore:

1. **At any time, each execution flow holds at most one per-view lock**, acquiring no second lock while holding the first. There is no “hold L1 while waiting for L2” situation, so **the lock wait graph has no edges**, cannot contain a cycle, and cannot deadlock. This is the standard at-most-one-lock argument: **one lock per critical section**.
2. For concurrent `A→B` and `B→A` on the same view, both acquire **the same** `migrationLock(v)`: its key is viewId, independent of direction. FIFO serializes them. One finishes in `AT_SRC`, `AT_DEST`, or `CLOSED` and releases; only then does the other restart from **the actual physical location at that time**. They cannot interleave or attach the view twice.

---

# Per-window teardown order

## Three operations for closing one window, and risks from reversing production order

Closing **one** window requires three operations:

1. **Compositor detach**: remove all its native views from `host.contentView` with `removeChildView`.
2. **scope.close()**: release the window-scope's owned view-scopes, sessions, anchor sinks, and wires in LIFO order (`scope.ts` and `disposable.ts`).
3. **`win.destroy()`**: destroy the Electron window.

Three constraints:

- **(a) Anchor use-after-free**: the renderer anchor (`view-anchor.ts`) continually calls `publish(bounds)` on the sink of a view being torn down. If that main-process sink calls `setBounds` on a detached or destroyed native view, it causes use-after-free or throws. Anchor publishing is synchronous; the main-process sink must only accept bounds while the native view is alive.
- **(b) Whether owned anchors/wires need a live `win` for graceful unsubscribe** has two cases:
  - **Wire / ipcMain handler**: unsubscribe means `ipcMain.removeHandler` or removing a listener. It is **main-process work, independent of window liveness**. The app-level precedent exists because the reverse order—disposing the registry while windows remain alive—causes problems (see `deck-app.ts`). Graceful wire unbinding therefore **does not require a live window**, but must finish **before the window dies**, otherwise the renderer may send to removed handlers.
  - **Anchor sink**: graceful cleanup means **stop accepting publish calls** by disposing the sink. This is also main-process work and **does not require a live window**. However, **the native view must still be attached and alive** if sink cleanup reads or writes it. Dispose the sink **before** native-view detach to stop publishing (see the use-after-free-safe order below).
- **(c) Compositor unmount uses `win.contentView` and throws once win is destroyed**: `removeChildView` on a destroyed contentView throws, just like commit. **Compositor detach must therefore precede `win.destroy()`**.

## Use-after-free-safe order

```
closeWindow(W):                              Rationale
─────────────────────────────────────────   ─────────────────────────────────
STEP 0  Stop anchor publish (dispose sinks)   Constraints (a)+(b-anchor): stop publishing first;
        — prevent bounds writes to views        subsequent RO/resize ticks bail synchronously
          being torn down                       (view-anchor.ts: `if(disposed) return`)
                                              ── Renderer anchors synchronously check
                                                 disposed/present, with no queued frames;
                                                 stopping the sink prevents new bounds
                                                 reaching the main process (I3)
─────────────────────────────────────────
STEP 1  Compositor detaches all native views  Constraint (c): precede win.destroy,
        (removeChildView one at a time,          because contentView operations throw after death
         while win is still alive)            ── Use commit's host-destroyed preflight:
                                                 an already-destroyed host makes commit
                                                 a silent no-op, without throwing
                                                 (see protection interaction below)
─────────────────────────────────────────
STEP 2  Unbind wire / ipcMain handlers        Constraint (b-wire): precede win.destroy,
        (wire resources in registry/scope)      otherwise renderer teardown handlers call
                                                 removed handlers (deck-app.ts app-level
                                                 precedent refined for one window)
─────────────────────────────────────────
STEP 3  Release the view's remaining          LIFO, following scope.close semantics
        scoped resources
        (session / child view-scope / others)
─────────────────────────────────────────
STEP 4  win.destroy()                        Last: every operation needing a live window
                                                 or attached native view has finished
─────────────────────────────────────────
```

**Combined order**: `stop anchor publish → Compositor detach all native views → unbind wire → scope releases remaining resources in LIFO order → win.destroy() last`.

Key points:

- **STEP 0–3 all run while `win` is alive**; `win.destroy()` is **last**. This does **not contradict** the app-level “windows before registry” precedent. That precedent requires **wire/registry unbinding during the period when renderer windows can still send messages, before those windows are destroyed**. App-level teardown destroys all windows at once, expressed as “destroy windows, then disposeAll registry.” Its safety comes from `win.destroy()` removing renderers **before** registry disposal. Per-window teardown is more granular: **stop publish (STEP0) → detach native views (STEP1) → unbind wire (STEP2) → destroy (STEP4)**. The claimed safety is the same: **renderers do not send to removed wire handlers**, because STEP4 removes the renderer after STEP2 unbinds the wire; anchors have already stopped in STEP0 and cannot write bounds after STEP1 detaches native views.
- **Why STEP1 detach precedes STEP2 wire unbinding**: detach requires a live `win.contentView` (constraint c) and is independent of wire unbinding. Either relative order is safe; this contract chooses detach→wire to complete operations requiring attached native views as early as possible.

## Interaction with destroyed-host commit protection

Compositor commit/detach in the teardown path (STEP1) **must never throw**. Otherwise teardown fails midway, leaving the window undestroyed and scope resources unreleased. The contract requires:

- **STEP1 detach uses commit preflight semantics**. If teardown finds an already-destroyed host (`host.isDestroyed`) and would otherwise call removeChildView, step 2 under “Exact commit failure semantics”—**no-op commits neither throw nor touch the host**—must cover it. An empty post-detach target produces a diff with no additions but some removals, so this needs **special handling**: removals on a destroyed host are meaningless (views disappeared with contentView). **Preflight must classify “destroyed host + removals only” as a silent no-op**, rather than throwing `host-destroyed`.

  > This is an **exception** to step 3's “pending work + destroyed host → throw host-destroyed.” If **the work contains only removals and the host is destroyed**, the views physically no longer exist; **treat detach as complete and return silently**, without throwing. Throw only if work contains additions (attempts to add views to the destroyed host). This exception is **specifically for teardown**: teardown only detaches (removes), never adds, so its commit **is guaranteed not to throw** when the host is destroyed first.

- **STEP4 `win.destroy()` follows STEP1**. On the normal path, the host is alive at STEP1 and detach succeeds without the exception. The exception only covers the race where an external cause (crash / OS) destroys win before closeWindow starts.

## Encoding semantic order with Scope.own() LIFO

`Scope` releases resources in **LIFO** order: **the first `own()` registration runs last** (`disposable.ts` uses `entries.slice().reverse()`; `scope.ts` releases children before resources, both in LIFO order). For execution order `STEP0 → STEP1 → STEP2 → STEP3`, **registration order must be reversed**:

```
After creating window-scope (one Scope per window), register own() in this order
(release runs in reverse):

  ws.own(() => win.destroy())                    // own first ⇒ run last = STEP4 ✔
  ws.own(disposeOtherResources)                  //                    STEP3
  ws.own(() => wire.dispose())                   //                    STEP2
  ws.own(() => compositor.detachAll(W))          //                    STEP1
  ws.own(() => anchorSink.dispose())             // own last ⇒ run first = STEP0 ✔
```

Thus **registration order is the reverse of execution order**. The first owned resource, `win.destroy()`, runs last; the last owned operation, anchor sink disposal, runs first. `closeWindow(W)` ≡ `ws.close()`: a single `close()` executes STEP0→STEP4 in the **exact order** above. The `scope.ts` completion fence guarantees that **teardown has finished when the `close()` Promise resolves** (`scope.ts`).

Key points and checks:

- **Register `win.destroy()` with own() first**, so it runs last. Omitting it or using the wrong order can destroy the window before native views are detached (before STEP1), triggering constraint (c). This registration order is **essential to correctness**, not a style preference.
- **Register anchor sink disposal with own() last**, so it runs first (STEP0), stopping publish immediately.
- Use `ws.child()` for view child scopes. Cross-level LIFO ensures **the child's entire teardown precedes resources directly owned by the parent ws** (`scope.ts`). A view instance owning its native ref or anchor releases them before the parent reaches `win.destroy()`, naturally satisfying “STEP4 last.”
- **Relationship to app-level teardown**: app-level teardown (`deck-app.ts`) iterates all windows with `win.destroy()`, then calls `registry.disposeAll()`. This contract requires **per-window teardown to use the own() LIFO encoding above, and app-level shutdown to call it**. “Windows before app-registry” then follows automatically: STEP2 within each ws.close() already unbinds that window's wire, leaving only app-level shared resources in the app registry.

---

## Appendix: contract quick reference

**Commit failure semantics**

- No-op (no additions or removals): return silently without touching the host.
- Pending work + destroyed host: preflight throws `host-destroyed{applied:false}` (native state untouched). **Exception**: removals-only work returns silently (for teardown; see the protection interaction section).
- Unexpected throw during apply: attempt snapshot rollback, then throw `apply-failed{recovered:bool}`.
- Successful commit: return `void`, with native state at the new target.

**moveTo state machine**: final physical state ∈ `{AT_SRC, AT_DEST, CLOSED}`. `DETACHED` is only a transient while the lock is held. Rollback is independent of dest failure kind and always reattaches at src.

**Deadlock-free migrationLock**: per-view locks; each critical section **holds only one lock and acquires no second lock** → no edges in the lock wait graph → no cycles → no deadlock. `A→B` / `B→A` on the same view share one FIFO-serialized lock.

**Exact teardown order**: `stop anchor publish → Compositor detach native views → unbind wire → scope releases remaining resources in LIFO order → win.destroy()`.

**own() encoding**: registration order reverses execution order. Register `win.destroy()` **first** (runs last), anchor sink disposal **last** (runs first).

**Use-after-free protection**: STEP0 stops publish; detach precedes destroy; teardown commits for “destroyed host + removals only” return silently without throwing.
