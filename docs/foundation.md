# Connection layer reference

The connection layer in `electron-deck/main` provides `Connection` and `ConnectionRegistry`, deterministic resource cleanup tied to connection lifetime, and the observational `debugTap`. Downstream hosts use it to associate resources with webContents and clean them up when that webContents is destroyed.

This reference explains the model, usage, required semantics, and boundaries for engineers using this layer.

Implementation:

- `src/main/connection.ts`: `Connection` and `ConnectionRegistry`
- `src/main/disposable.ts`: `DisposableRegistry`
- `src/main/debug-tap.ts`: `debugTap`

---

## 1. The problem it solves

Main-process resources, such as IPC-handler state, event subscriptions, CDP-service detach decisions, and routing-layer page entries, belong to a webContents and should disappear when it is destroyed. Without a connection primitive, each subsystem maintains its own `once('destroyed')`, `removeChildView`, and teardown wiring, making omissions easy.

The connection layer makes **webContents destruction → cleanup of its owned resources** a framework invariant. Register resources with `own()` and let the connection dispose them at the correct time.

---

## 2. Core model

### Connection is a first-class per-webContents object

One `Connection` corresponds to one webContents, keyed by the unforgeable identity **`wc.id`**. Connections are **flat, not nested**:

- A top-level view-host `WebContentsView` has one webContents and one connection.
- Each per-page render-host `<webview>` inside it has a separate webContents and a separate connection.

Cross-connection state, such as sessions, page stacks, and the active render target, stays in the host's routing or domain layer. The connection layer provides a resource container and lifecycle events for a webContents; it neither duplicates nor replaces active-target decisions.

Each connection owns a **`DisposableRegistry`** for one lifetime segment. Resources registered in that segment are disposed deterministically in **LIFO** order when it ends.

### Interfaces

```ts
interface Connection {
	readonly id: number // webContents.id, an unforgeable identity
	readonly webContents: WebContents
	readonly alive: boolean
	/** Own a resource for the current segment; dispose the returned handle to release it early. */
	own(d: Disposable | (() => void)): Disposable
	/** Subscribe to connection lifecycle events; dispose the returned handle to unsubscribe. */
	on(ev: 'reset' | 'closed', cb: () => void): Disposable
}

interface ConnectionRegistry {
	/** Acquire or create a connection for webContents; idempotent. */
	acquire(wc: WebContents): Connection
	get(id: number): Connection | undefined
	all(): readonly Connection[]
	/** Soft reuse: dispose the current segment and install a fresh registry. */
	reset(id: number): void
}
```

`createConnectionRegistry()` creates the registry. Hosts expose it as `DeckContext.connections` and acquire connections at the actual wiring points: app startup, view management, message routing, and debugger services.

Section 3 and the code comments describe wiring semantics. Application-specific usage is outside this repository's documentation scope.

---

## 3. Choosing between `own()` and `on('closed')`

Connections have two teardown paths (section 4). `own()` and `on('reset'|'closed')` behave differently on them. Choosing the wrong one can leave resources behind after reuse or remove wiring prematurely.

| Registration       | reset (soft reuse) | close (destruction) | Disposal or unsubscription                                                                             |
| ------------------ | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `own(d)`           | Runs               | Runs                | `dispose()` removes the entry and **runs its disposer immediately**; reset/close will not run it again |
| `on('reset', cb)`  | Runs               | Does not run        | Disposing the returned handle removes the listener without firing it                                   |
| `on('closed', cb)` | Does not run       | Runs                | Same listener-removal semantics; removing it does not fire it                                          |

- **Session-lifetime resources use `own(d)`.** A resource valid only for the current session should be removed when reset changes the session. For example, a routing layer owns the current `serviceWc → sessionId` binding on the service-host connection. Pool reuse resets the same webContents, removing the old binding before the new session creates a fresh one. CDP forwarding and render-tree inspection also use `own()`.
- **WebContents-lifetime resources use `on('closed', cb)`.** Wiring for the webContents itself must survive sessions and disappear only when that webContents is destroyed. For example, “open in external editor” wiring installs a host-defined event listener and a deduplication entry on service-host webContents. It remains valid after pool reset; rewiring the same `wc.id` would return early because of deduplication. Using `own()` would remove it at reset and leave the reused webContents without that wiring.

> Ask whether a resource belongs to **this session** or **this webContents**. Use `own` for the session and `on('closed')` for the webContents.

Because `acquire()` is idempotent, routing-layer session resources registered through `own()` and external-editor wiring registered through `on('closed')` can coexist on the same service-host connection.

---

## 4. Two teardown paths

### Destruction (close)

The terminal hook is **`wc.once('destroyed')`**, not `render-process-gone`. During `render-process-gone`, `wc.isDestroyed()` may still be false. Using `destroyed` avoids that inconsistent interval.

Close synchronously sets `alive=false` and removes the connection from the registry, so `get(id)` no longer finds it. It then starts asynchronous `disposeAll()` for the current segment and fires `'closed'`.

### Soft reuse (reset)

A host's service-host pool may navigate a prewarmed window to blank and reuse its webContents for a new session. `wc.id` stays the same, but the session changes. Reset disposes the old segment, installs a fresh `DisposableRegistry`, and fires `'reset'`; **the connection object remains alive**.

The segment replacement is synchronous: reset installs the new registry before returning, while disposal of the old segment continues asynchronously. Subsequent `acquire` and `own` calls immediately see the open new segment. Old `own()` handles still refer to the replaced segment and **cannot affect the new one**. Their disposers run at most once. Disposing such a handle before the old segment marks it released runs its disposer immediately; later calls are no-ops.

> Reset must replace the registry rather than empty and reuse it: `DisposableRegistry.disposeAll()` permanently sets `_disposed`, and subsequent `add()` calls throw. Never register new resources on that disposed instance.

**Events fire at the start of teardown**, when `disposeAll()` begins, not when it finishes. Domain services can prune their graphs then, but must not assume all owned resources are already gone; asynchronous disposers may still be running.

### Who triggers reset

The pool exposes no connection-layer emit or callback. The **routing layer** synchronously calls `connections.reset(serviceWc.id)` during session teardown, **before** returning the window to the pool. This clears the old session's owned resources before the next session takes over. Actual destruction still uses the connection's own `'destroyed'` close hook.

### Guards for destroyed webContents

Calling `acquire` for already-destroyed webContents returns a dead connection that is **not alive and not registered**. Its `own()` immediately disposes incoming resources, and `on()` returns a no-op. This avoids attaching a never-fired `'destroyed'` hook and leaving a permanently alive zombie connection.

Calling `own()` after close is also safe. It does not forward to the disposed old registry, which would throw; it immediately disposes the incoming resource and returns a harmless no-op. Both synchronous throws and asynchronous rejections from that disposer are caught and logged, preventing late teardown from causing an unhandled rejection in Electron's main process.

---

## 5. Two layers of trust

Connection existence and invocation trust are separate concerns.

- **Admission (who calls acquire):** the acquiring layer decides, without a single global gate. Public IPC senders use the global sender allowlist (main, settings, overlay, or explicitly trusted windows). Restricted service-host, native view-host, and render-guest connections are acquired directly by their routing or view-management layers according to domain ownership, without that global allowlist.
- **Routing ownership:** the routing layer decides whether a sender is the current session's service, view-host, or render wc. This is ownership, not a trusted boolean, and remains in the domain layer.

view-host, service-host, and render-guest are deliberately excluded from the global trust allowlist to limit impact. They can have a **restricted connection**, meaning a resource-lifetime container, without being trusted for every API. Their domain layers decide trust through embedder relationships, bridgeId associations, or exact sender-ID checks. The connection layer does not make those decisions.

A connection provides ownership and lifetime, not authorization for these restricted APIs.

---

## 6. Dispatch carries WebContents objects

Pass the **WebContents handle**, not only `senderId: number`, through dispatch. Routing relies on object identity: `page.renderWc !== sender`, `wc.isDestroyed()`, long-lived references, and connection-owned terminal cleanup through `connections.acquire(sender).own(...)`. A numeric ID alone cannot support these uses.

Accordingly, `acquire(wc)` accepts the object, `connection.webContents` exposes it, and `connection.id` exposes its unforgeable numeric identity.

---

## 7. In-flight requests and reset races

The most dangerous reuse race is an old session's late response reaching a new session on the same webContents. Connection and routing layers prevent this using **session-generation identity, not webContents liveness**:

- After destruction, reject new dispatches but let in-flight invocations finish. If webContents is dead at send time, discard the result through the egress guard.
- Route late responses by **`sessionId`**, unique for each new session, and validate the sender. After reset, an old response is discarded when its pending entry no longer exists or its sender does not match. Liveness cannot distinguish it: the reused wc is still alive and still has the same `wc.id`.
- Reset replaces the segment, disposing old session resources and giving the new session a clean segment.

---

## 8. debugTap

`debugTap` is a flag-gated ring buffer for observing IPC or cross-webContents message flow. Install it at the host's central bridge-frame dispatch handler to inspect cross-webContents state machines.

- **Off by default:** enable with `DEBUG_TAP=1`. When disabled, `record()` is a near-zero-cost no-op and adds no meaningful production hot-path work.
- **Caller-supplied `ts`:** the caller timestamps each entry. The electron-deck package does not call `Date.now()`, preserving determinism and resumability.
- **Bounded:** a fixed-capacity ring, **1000** entries by default, evicts the oldest entries first and never grows without bound.

`DebugTapEntry` records `ts`, `channel`, `direction` (in/out), `connectionId`, `sessionId`, `durationMs`, `error`, and `summary` (a short payload summary, not a large blob). `entries()` returns a snapshot copy; callers cannot mutate the live ring through it.

```ts
const tap = createDebugTap({ enabled: process.env.DEBUG_TAP === '1' })
tap.record({ ts: Date.now(), channel: 'invoke', direction: 'in', connectionId })
const recent = tap.entries() // oldest → newest
```

---

## 9. Minimal usage

```ts
import { createConnectionRegistry } from 'electron-deck/main'

const connections = createConnectionRegistry()

// Session-lifetime resources: cleaned up on both reset and close.
const conn = connections.acquire(serviceWindow.webContents)
conn.own(() => {
	if (wcIdToSessionId.get(conn.id) === sessionId) {
		wcIdToSessionId.delete(conn.id)
	}
})

// WebContents-lifetime resources: removed only on destruction, surviving sessions.
const conn2 = connections.acquire(serviceWc)
conn2.on('closed', () => {
	serviceWc.removeListener('host-custom-event', onHostEvent)
})

// Soft reuse: triggered by host routing before the session changes.
connections.reset(serviceWc.id)
```

---

## 10. Boundary checklist

- The connection layer **does not own debugger sessions or perform centralized detach**. `wc.debugger` has one per-wc owner and is cooperatively shared by CDP services. Each service detaches only what it attached and owns that detach decision through the connection. Calling `debugger.detach()` globally on connection close would remove other services' sessions, such as a safe-area `Emulation.setSafeAreaInsetsOverride` override.
- Cross-connection state, including active render targets, stays in the host's routing layer.
- Soft reuse replaces the segment through reset; adding to a disposed `DisposableRegistry` throws.
- Discard late responses by `sessionId`, not wc liveness.
- debugTap takes timestamps from callers rather than reading a clock in the package.
