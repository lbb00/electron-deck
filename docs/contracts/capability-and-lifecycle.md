# Capability authorization and lifecycle contract

This document defines three security- and lifetime-sensitive interfaces, data shapes, and invariants: **senderId propagation and grant gating**, **atomic anchor slotToken delivery**, and **tab keep-alive ownership**. Implementation belongs to this package's wire, ControlBus, and scope layers. 🔒 marks security invariants; 🧪 marks requirements needing real-device or E2E evidence.

---

## 0. Related primitives

- `src/internal/wire-transport.ts`: `handleInvoke` has senderId and frame, checks trust and main-frame admission, then constructs `InvokeCtx` and passes it to `invokeHost(name, args, ctx)`.
- `src/host/control-bus.ts`: `dispatch(name, args, ctx)` resolves the command, checks the grant policy, and calls `handler(...args)`. Hosts wire it in `backend.assemble` with `invokeHost = (name, args, ctx) => controlBus.dispatch(name, args, ctx)`; deck-app does not wire ControlBus.
- `src/internal/trust-set.ts`: a reference-counted membership set. `isTrusted(id)` scans `wc.id`. It answers whether a sender is trusted, not whether it may invoke a particular command; that is the grant gate's responsibility.
- `src/main/scope.ts`: nested lifetime and completion fences. `on('reset'|'closed', cb)` marks generation boundaries: reset means soft reuse (navigation/project close), and closed means termination (window close/destruction). Grants are revoked on both events.
- `src/internal/deck-app.ts`: each trusted wc has a wcScope that closes when it is destroyed. To make wc.id reuse safe, bind a grant's `senderScope` to such a lifetime. deck-app does not automatically supply that scope to grants and has no `runtime.grants` convenience wrapper.
- `view-anchor/src/view-anchor.ts`: `createViewAnchor(target, { visible, publish })` measures in the renderer and publishes `Placement`. `publish` has no slot identity. The control-layer IPC client (`createDeckLayoutClient`) adds slotToken through its sink closure (see “Atomic anchor slotToken delivery”). Bounds may have negative x/y; `clampRect` clamps only width/height to ≥0. Slot validation must not discard negative coordinates needed for scrolling.

---

## senderId propagation and mandatory grant gating

### Passing senderId through `InvokeCtx`

The wire's sender identity reaches dispatch through `InvokeCtx`:

```ts
// InvokeCtx (exported by host/index.ts)
export interface InvokeCtx {
	/** Invoking webContents ID, available only after the wire trust and main-frame checks. */
	readonly senderId: number
	/** Originating frame, already validated as the main frame; reserved for future frame-level policies and may be null. */
	readonly senderFrame: FrameRef | null
}
```

Signatures:

```ts
// WireTransportDeps
invokeHost: (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>

// ControlBus
dispatch(name: string, args: readonly JsonValue[], ctx: InvokeCtx): Promise<JsonValue>
```

`handleInvoke` constructs ctx **after** trust and main-frame checks pass. senderId is then a number and the frame has been validated, making the construction point fail-closed:

```ts
// Inside wire-transport.ts handleInvoke, after the gates:
const ctx: InvokeCtx = { senderId, senderFrame: senderFrame ?? null }
const result = await this.deps.invokeHost(req.name, req.args, ctx)
```

🔒 ctx is **required**, with no optional `ctx?` default. An optional default would silently turn a missing context into dispatch without sender identity, replacing a compile-time error with a runtime authorization omission. `ControlBus.dispatch` needs the actual senderId to evaluate a grant.

### Hard boundary between the two invoke routes

`WireTransportDeps.invokeHost` supports two wiring choices:

- **Default route:** `invokeHost = (name, args, ctx) => ipc.invoke(HOST_PREFIX+name, ...args)` uses `InMemoryTypedIpcRegistry` for declarative `hostServices`. It checks trust, **not grants**: a trusted sender may invoke the service. deck-app's `bindWireTransport` uses only this route; its runtime no longer has configuration for switching to ControlBus because `runtime.layout.command` wiring was removed.
- **ControlBus route:** `invokeHost = (name, args, ctx) => controlBus.dispatch(name, args, ctx)` carries layout/privileged commands and provides grant gating. Hosts independently assemble `WireTransport` and `createControlBus`, optionally with a `createCapabilityRegistry` policy. deck-app's runtime factory does not provide this wiring.

Both signatures accept ctx; the default route accepts it without using it.

> 🔒 **Layout and privileged commands must go through ControlBus.** The grant gate exists only in `ControlBus.dispatch`. Hosts assembling `WireTransport` for commands that drive native views, lifetimes, or cross-window actions (such as `layout.*`) must register and dispatch them through ControlBus, never through ordinary `hostServices` or `InMemoryTypedIpcRegistry`. Registering a privileged name on the default route bypasses grant authorization and lets any trusted control layer invoke it. Enforce this boundary at wiring time so privileged names cannot reach ordinary hostServices. This matches the ControlBus routing requirement in `architecture.md`.

### Grant data and the gating point

Grant data is general infrastructure in `host/capability.ts`, exported by `electron-deck/host`:

```ts
export interface Grant {
  /** Authorized sender: the control-layer renderer webContents ID. */
  readonly senderId: number
  /** Grant lifetime: revoked automatically on this Scope's reset/closed events. The caller
   *  supplies it; deck-app.ts does not automatically fill in the wcScope for a wc. */
  readonly senderScope: Scope
  /** Allowlisted command names, matched exactly with default denial. */
  readonly commands: ReadonlySet<string>
}

// Host side:
const { policy, issue } = createCapabilityRegistry()
issue({ senderId, senderScope, commands: new Set(['layout.resize', ...]) }): Disposable
//   The host supplies senderScope, usually tied to sender reset/destruction.
```

The injected policy denies by default:

```ts
export interface CapabilityPolicy {
	/** True only for a live grant with matching senderId and name ∈ commands. */
	allows(senderId: number, name: string): boolean
}
```

In `control-bus.ts`, `dispatch` checks grants **after** resolving the command and **before** invoking its handler:

```ts
async dispatch(name, args, ctx): Promise<JsonValue> {
  const handler = commandRegistry.get(name)
  if (!handler) throw new Error(`no command registered: ${name}`)
  // 🔒 Grant gate: wire has already checked sender trust. Here check whether the trusted
  // sender is authorized to invoke this command. Deny by default.
  if (policy && !policy.allows(ctx.senderId, name)) {
    throw new DeckRemoteError(name, `forbidden: ${name}`, DECK_CODE.Forbidden)
  }
  return handler(...args)
}
```

The gate order must remain **wire trust → wire main-frame → ControlBus grant → handler**. Trust determines whether senderId is trusted; grants determine whether that trusted sender may invoke this command. The grant gate adds a second boundary and never replaces trust admission.

> `createControlBus` accepts optional `policy?: CapabilityPolicy`. Without a policy there is no grant gate, preserving the existing behavior where trusted senders can dispatch ordinary RPCs registered with `command()`. Hosts get the gate only when they create grants with `createCapabilityRegistry()` and pass its policy to `createControlBus`. Omitting policy preserves compatibility; once policy is supplied, commands not covered by a grant must be denied by that policy.

The error code is `DECK_FORBIDDEN` (`DECK_CODE.Forbidden` in `wire-transport.ts`). Throwing `new DeckRemoteError(name, 'forbidden: …', 'DECK_FORBIDDEN')` passes through `serializeError`, preserving remoteName and code, so clients receive `{ ok:false, error:{ code:'DECK_FORBIDDEN' } }`. 🔒 This reuses the existing faithful `DeckRemoteError` serialization path without adding frame logic.

### Binding grants to Scope generations

Inside `createCapabilityRegistry().issue(grant)` in `host/capability.ts`:

1. Add the grant to the policy's active set indexed by senderId.
2. Subscribe to both events on `grant.senderScope` to revoke automatically:

   ```ts
   const off1 = grant.senderScope.on('reset', () => revoke(grant)) // Navigation/project close → revoke old authorization
   const off2 = grant.senderScope.on('closed', () => revoke(grant)) // Window close/destruction → revoke
   ```

   `revoke` removes the grant from the active set and disposes both subscriptions. The Disposable returned by `issue` also calls `revoke`, allowing early manual withdrawal.

3. 🔒 Grants match by `senderId`. If the host binds `senderScope` to a Scope that closes when that wc is destroyed, automatic revocation prevents a new window reusing wc.id from inheriting old authorization. This is a **binding requirement**, not a registry guarantee independent of scope provenance.

The per-wc wcScope in `unified-lifetime.md` section 3 has the right generation semantics: it is created for a window/view's control wc during assembly, closed with `void wcScope.close()` in `win.on('closed')`, and reset with `wcScope.reset()` for navigation reuse. However, deck-app exposes no public handle for that scope and no longer fills it into Grant automatically. `capability.ts` is general infrastructure independent of deck-app; the caller chooses `senderScope`. Safe wc.id reuse therefore depends on the caller's correct lifetime binding.

🧪 Verify that navigation/reset or window closure rejects old grant commands with `DECK_FORBIDDEN`. A new window reusing the same wc.id must not inherit the old grant, provided senderScope is correctly bound to that wc's lifetime.

---

## Atomic anchor slotToken delivery

slotToken distinguishes multiple native-view slots on one control wc (for example, #preview and #panel) and prevents a renderer from moving another view by reporting another slot's bounds. `publish(Placement)` has no slot identity, so the handshake supplies it and closes the frame-long gap where a view exists but its renderer measures before receiving identity.

### Atomic delivery handshake

🔒 **The renderer never reports bounds before receiving that slot's slotToken.** Subscribe first, receive the main-process token push, then begin measuring. The renderer does not guess an ID.

Data:

```ts
// Generated by main when each native view is created
interface SlotGrant {
	readonly viewId: string // Compositor NativeViewRef.id
	readonly slotId: string // DOM slot ID ('#preview'), used by the renderer to locate the target
	readonly slotToken: string // Unguessable crypto nonce; main privately stores token→(viewId, authorized wc, zone)
	readonly generation: number // Main-assigned, monotonic per wc; stamped into snapshots; a higher generation on reload resets the main reconciler
}
```

Handshake, atomic with view creation:

```
main: runtime.view({...}).placeIn(controlWc, { anchor:'#preview' })
  1. Compositor assigns viewId; generate slotToken (nonce).
  2. Register in main's private table: token → { viewId, authorizedWcId: controlWc.id, zone }.
  3. controlWc.send('__deck:slot-grant', { viewId, slotId, slotToken, generation }); push without waiting for the renderer.
  ──────────────────────────────────────────────────────────────────────────
renderer (control-layer, createDeckLayoutClient)
  4. Subscribe to '__deck:slot-grant' at startup, before any measurement.
  5. Receive the grant → locate the DOM target by slotId → createViewAnchor(target, { ... }).
     The anchor publishes to a central placement publisher, not directly to IPC per view.
  6. Each frame, the publisher combines all anchors' latest measurements into one window-level snapshot.
     Each view carries its own slot token as extra:
       send('__deck:snapshot', { generation, epoch, views:[{ viewId, placement, layer, extra:{ slotToken } }] })
```

Coalescing a window-level state table rather than sending per-view edges addresses stuck white views. A relayout can briefly measure a slot as 0×0 and restore it; coalescing overwrites that transient measurement before publication. Even if a bad frame escapes, main reconciles the complete table and recovers within ≤1 frame, rather than leaving a view permanently detached as the old edge stream could.

Two guarantees prevent reporting before token receipt:

- The slot-grant event creates the renderer anchor (steps 4 → 5), rather than page load. Without a grant, no anchor exists and nothing can publish.
- Main sends the grant without waiting for an acknowledgement. If renderer subscription follows the send, replay handles the race: main buffers sent but unconsumed grants and drains them on first subscription. This mirrors late-listener replay for `pendingWindowCreated` and `pendingLoadFailed`. Either ordering delivers the grant before creating the anchor.

> The IPC client (`createDeckLayoutClient`) captures slotToken in its sink closure and adds it to the frame **outside view-anchor**. view-anchor remains an engine-independent measuring primitive with an injected sink, no token knowledge, and no Electron or protocol dependency.

### Validating slot reports: authorize → reconcile → dispatch

After the snapshot IPC handler receives `{ generation, epoch, views:[...] }` through trust and main-frame admission, it runs three pure-function stages from `src/layout/snapshot-reconcile.ts` and `placement-reconcile.ts`:

```
1. authorizeSnapshot(raw, authorize): authorize each view and produce a trusted CleanSnapshot.
   a. Look up token → { viewId, authorizedWcId, zone } in the private table; discard unknown tokens.
   b. Require senderId === authorizedWcId; otherwise discard the view (B cannot report A's slot).
   c. Take viewId and layer(zone) from the private table, never from renderer fields.
      A valid token cannot poison reconciliation by pairing it with a forged viewId.
   d. Validate placement.bounds: visible:false needs no bounds; visible:true requires width/height ≥0.
      Negative x/y are valid for scroll following; view-anchor clampRect clamps only width/height.
   e. Deduplicate viewId, keeping the first.
   If raw.views is nonempty but every authorization fails, reject the snapshot (return null).
   Never interpret this as "detach all": transient token invalidation must not remove live views.
   An originally empty views table intentionally removes all views and can reconcile to detach.
2. reconcile(perWcState, clean): diff the complete desired table against the previous actual table into ordered operations.
   Staleness: reject generation < previous; reject equal generation with epoch <= lastEpoch;
   a higher generation resets and rebuilds state.
   Level triggering recovers from a lost/spurious frame; monotonic generation rejects old in-flight frames after reload.
3. applyReconciledPlacements: call ViewHandle.applyPlacement for affected views.
   visible:true sets bounds; visible:false detaches. Compositor manages z-order by zone;
   the deck ignores reorder operations.
```

Per-wc state consists of `reconcileStates` and the monotonic `perWcGeneration` counter. `__deck:layout-subscribe` on resubscription/reload increments that wc's generation, resets reconciliation, and resends all grants with the new generation. View disposal (Scope revocation) or window closure removes tokens from the private table and removes the wc's reconciliation/generation state; later bounds carrying those tokens are dropped.

🧪 Verify that two slots on the same control wc each drive only their own view; a trusted wc reporting another wc's slotToken is dropped without moving the target; and negative x/y during upward scrolling remain valid and follow normally.

---

## Tab keep-alive ownership

Tab switching uses `Placement{ visible:false }` to detach while keeping the view alive, preserving CDP, scroll position, and the JavaScript heap without reload. N hidden tabs mean N resident WebContents. Without a bound, a long session can grow memory indefinitely. This section assigns keep-alive lifetime and eviction-policy ownership.

### Scope owns keep-alive lifetime; the host owns eviction policy

| Primitive                            | Responsibility                          | Can it bound keep-alive views?                                                                                                                                  |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Layout / Placement (view-anchor)** | DOM ↔ native geometry, measure → bounds | No. It knows position, not view age or last visibility. `visible:false` publishes detach; it does not own WebContents lifetime.                                 |
| **Compositor**                       | z-order and mount/unmount planning      | No. It knows render order. Unmount establishes new-instance semantics on remount; it neither owns nor decides WebContents destruction.                          |
| **Scope**                            | Nested lifetime and completion fences   | It owns lifetime but has no “last shown” input. close/reset are structural events (window close, navigation, host calls), not time/visibility policy decisions. |
| **ControlBus**                       | RPC, events, trust                      | No. It is orthogonal to lifetime.                                                                                                                               |

A bound on hidden tabs (LRU, max-N, or TTL) is policy, not a primitive's inherent responsibility. Geometry and compositor should not decide lifetime. Scope owns lifetime but responds to structural events, not time- and visibility-based eviction.

**Scope owns structural keep-alive lifetime; eviction defaults to the host:**

- Each kept-alive tab view is a Scope child that owns its WebContents. Parent close/reset on window or project closure destroys it. The framework guarantees this lifetime correctness.
- Which excess hidden tab to evict is a host product decision. The framework has no default LRU. Hosts may dispose a long-unused ViewHandle on tab changes; disposal closes its Scope child and destroys WebContents.

What counts as “recently used”, the bound N, and which tabs deserve retention vary by application. The framework should not guess product intent, but must guarantee destruction and prevent leaks when a lifetime ends.

### Opt-in helper: `runtime.view({ keepAlive })`

A small opt-in helper covers the common bounded-LRU policy:

```ts
runtime.view({
	source,
	scope: session,
	keepAlive: { policy: 'lru', max: 6 }, // Optional; omit for host-controlled eviction with no framework eviction
})
```

When keepAlive is provided:

- Maintain an LRU list per policy group. A `visible:true` view is marked recently used.
- If the group's hidden (`visible:false`) kept-alive view count exceeds `max`, dispose the one that has gone longest without being shown, closing its Scope child and destroying WebContents.
- Never evict a currently `visible:true` view; only hidden views are eligible.

Only `lru` and `max` are built in. Omitting keepAlive leaves all eviction to the host. Scope ownership always guarantees lifetime correctness; the host owns policy by default, with the common LRU available as a one-line opt-in. Do not add TTL or other policies that would turn the helper into a policy framework.

🧪 On real hardware verify that switching to tab N+1 destroys the least-recently-shown hidden tab's WebContents (memory falls or `webContents.isDestroyed()` confirms it), window/project close destroys every kept-alive tab through Scope without leaks, and omitting keepAlive leaves hidden tabs alive without framework eviction.

---

## Appendix: security invariants and required evidence

🔒 **Required design and implementation invariants:**

- Grants: required ctx, fixed `trust → main-frame → grant` order, and default-deny grant policy.
- Grant lifetime: bind to a Scope that closes with the wc; reused wc.id must not inherit old grants.
- slotToken: no reporting before token receipt; private token → (viewId, authorized wc) lookup and sender match; negative x/y remain valid.
- Tab retention: Scope must own kept-alive WebContents and destroy them on window/project closure.

🧪 **Real-device/E2E evidence, beyond type checking or unit tests:**

- A real webview → main invocation carries the correct senderId; navigation/closure revokes old grants with `DECK_FORBIDDEN`; wc.id reuse inherits no authorization.
- Multiple slots drive their own views; unauthorized tokens are dropped; negative coordinates follow scrolling.
- LRU eviction actually destroys WebContents; Scope cleanup has no leaks; omission of keepAlive causes no eviction.

## Appendix: implementation pitfalls

1. **Per-wc Scope:** safe wc.id reuse requires senderScope to close with its control wc. deck-app has this wcScope internally but exposes no public handle. ViewHandle shares this lifetime foundation; see `unified-lifetime.md`.
2. **Invoke-route boundary:** grants exist only in `ControlBus.dispatch`. Layout/privileged commands must go through ControlBus, never the default `InMemoryTypedIpcRegistry`/hostServices route. Otherwise the grant gate is bypassed. Enforce the boundary in wiring, as described above and in `architecture.md`.
3. **Replay drain timing:** replay resolves renderer subscription versus main send races, like pendingWindowCreated. First renderer subscription drains the complete queue with splice(0), partitioned by control wc so grants never cross between wcs.
