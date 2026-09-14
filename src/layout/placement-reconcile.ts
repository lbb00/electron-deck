// Level-triggered reconciler that converges a host's native-view mount state
// toward a renderer-declared desired placement. The renderer is the single
// source of truth: it publishes a window-level snapshot (one monotonic epoch
// per commit tick, one generation per renderer lifetime); this pure core diffs
// the snapshot against the last-applied actual state and emits an ordered op
// list. A lost or spurious per-view edge is self-correcting because every
// reconcile re-derives the whole actual state from the desired snapshot, so the
// worst case degrades from a stuck view to a one-tick flicker.
//
// Domain-neutral: view ids are opaque strings and per-view host specifics ride
// on the `Extra` type parameter (e.g. a simulator's zoom), so the same core
// serves any electron-deck host. Side-effect free — it only computes ops; a
// thin host executor applies them.

import type { Bounds, Placement } from 'view-anchor'

export type { Bounds, Placement }

export interface DesiredView<Extra = unknown> {
  viewId: string
  placement: Placement
  // z-order; larger paints on top.
  layer: number
  // Host-specific extras carried through to setBounds (e.g. simulator zoom).
  extra?: Extra
}

export interface PlacementSnapshot<Extra = unknown> {
  // Renderer lifetime id. A snapshot behind the last-accepted generation is
  // rejected outright; a higher generation's snapshot still diffs against the
  // carried-forward actual table (see reconcile()'s generation-bump handling
  // below) so a view the new generation doesn't redeclare gets detached, not
  // silently forgotten.
  generation: number
  // Window-level monotonic tick; all views in one commit share one epoch.
  epoch: number
  // The full desired table for this tick (a level, not a delta).
  views: DesiredView<Extra>[]
}

export type ViewOp<Extra = unknown> =
  | { kind: 'setBounds'; viewId: string; bounds: Bounds; extra?: Extra }
  | { kind: 'attach'; viewId: string }
  | { kind: 'setVisible'; viewId: string; visible: boolean }
  | { kind: 'detach'; viewId: string }
  | { kind: 'reorder'; order: string[] }

export interface ActualView<Extra = unknown> {
  attached: boolean
  visible: boolean
  bounds?: Bounds
  extra?: Extra
}

export interface ReconcilerState<Extra = unknown> {
  generation: number
  lastEpoch: number
  desired: Map<string, DesiredView<Extra>>
  actual: Map<string, ActualView<Extra>>
}

export function createInitialState<Extra = unknown>(): ReconcilerState<Extra> {
  return {
    generation: 0,
    lastEpoch: -1,
    desired: new Map(),
    actual: new Map(),
  }
}

// Integer-snap so sub-pixel jitter (100.4 vs 100.6) never emits a setBounds op.
function roundBounds(b: Bounds): Bounds {
  const x = Math.round(b.x)
  const y = Math.round(b.y)
  const width = Math.round(b.width)
  const height = Math.round(b.height)
  if (x === b.x && y === b.y && width === b.width && height === b.height) {
    return b
  }
  return { x, y, width, height }
}

function sameBounds(a: Bounds | undefined, b: Bounds | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

// Structural equality for plain values and common structured-clone built-ins.
// Key insertion order does not affect plain objects; Map and Set iteration
// order remains observable. Unknown object types compare unequal.
function sameJsonValue(
  a: unknown,
  b: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime()
  if (a instanceof RegExp) return b instanceof RegExp && String(a) === String(b)
  const aObject = a as object
  const paired = seen.get(aObject)
  if (paired !== undefined) return paired === b
  seen.set(aObject, b)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!sameJsonValue(a[i], b[i], seen)) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  if (a instanceof Map || a instanceof Set) {
    if (!(b instanceof Map || b instanceof Set) || a.constructor !== b.constructor || a.size !== b.size) return false
    return sameJsonValue([...a.entries()], [...b.entries()], seen)
  }
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b)) return false
    if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false
    const aBytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const bBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    for (let i = 0; i < aBytes.length; i++) {
      if (aBytes[i] !== bBytes[i]) return false
    }
    return true
  }
  const aPrototype = Object.getPrototypeOf(a)
  if (aPrototype !== Object.prototype && aPrototype !== null) return false
  if (aPrototype !== Object.getPrototypeOf(b)) return false
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.hasOwn(bObj, k) || !sameJsonValue(aObj[k], bObj[k], seen)) return false
  }
  return true
}

function sameExtra<Extra>(a: Extra | undefined, b: Extra | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return sameJsonValue(a, b)
}

function visibleBounds<Extra>(dv: DesiredView<Extra>): Bounds {
  // Caller guarantees dv.placement.visible === true.
  return roundBounds((dv.placement as { visible: true; bounds: Bounds }).bounds)
}

function setBoundsOp<Extra>(id: string, dv: DesiredView<Extra>): ViewOp<Extra> {
  const bounds = visibleBounds(dv)
  if (dv.extra !== undefined) {
    return {
      kind: 'setBounds',
      viewId: id,
      bounds,
      extra: dv.extra,
    }
  }
  return {
    kind: 'setBounds',
    viewId: id,
    bounds,
  }
}

// Attached views ordered bottom→top by layer; id is a stable tie-break so a
// same-layer set never reorders spuriously.
function computeOrder<Extra>(
  actual: Map<string, ActualView<Extra>>,
  desired: Map<string, DesiredView<Extra>>,
): string[] {
  const attached: Array<{ id: string; layer: number }> = []
  for (const [id, a] of actual) {
    if (a.attached) {
      attached.push({ id, layer: desired.get(id)?.layer ?? 0 })
    }
  }
  attached.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const order: string[] = new Array(attached.length)
  for (let i = 0; i < attached.length; i++) {
    order[i] = attached[i]!.id
  }
  return order
}

// A view declared in the snapshot no longer being present means it must be
// removed: detach any still-attached actual whose id left the desired table.
function scanDetached<Extra>(
  actual: Map<string, ActualView<Extra>>,
  desired: Map<string, DesiredView<Extra>>,
  ops: ViewOp<Extra>[],
): boolean {
  let attachSetChanged = false
  for (const [id, a] of actual) {
    if (desired.has(id)) continue
    if (a.attached) {
      ops.push({ kind: 'detach', viewId: id })
      attachSetChanged = true
    }
    actual.delete(id)
  }
  return attachSetChanged
}

interface Buckets {
  hides: string[]
  shows: string[]
  restores: string[]
  updates: string[]
}

// Classify one desired view against the current actual, WRITE its next actual,
// and record which op bucket(s) it lands in. Returns whether it newly attached
// (which changes the attach set → forces a reorder).
function classifyView<Extra>(
  id: string,
  dv: DesiredView<Extra>,
  actual: Map<string, ActualView<Extra>>,
  buckets: Buckets,
): boolean {
  const a = actual.get(id)
  if (!dv.placement.visible) {
    if (a?.attached && a.visible) buckets.hides.push(id)
    if (a !== undefined && !a.visible) return false // already hidden; nothing to record
    actual.set(id, { attached: a?.attached ?? false, visible: false, bounds: a?.bounds, extra: a?.extra })
    return false
  }
  const bounds = visibleBounds(dv)
  if (!a || !a.attached) {
    buckets.shows.push(id)
    actual.set(id, { attached: true, visible: true, bounds, extra: dv.extra })
    return true
  }
  if (!a.visible) buckets.restores.push(id)
  const boundsChanged = !sameBounds(a.bounds, bounds)
  const extraChanged = boundsChanged ? false : !sameExtra(a.extra, dv.extra)
  if (boundsChanged || extraChanged) buckets.updates.push(id)
  if (a.visible && !boundsChanged && !extraChanged) {
    return false
  }
  actual.set(id, { attached: true, visible: true, bounds, extra: dv.extra })
  return false
}

// Fixed op order avoids attach-then-resize / squashed-toolbar flicker:
// detach → hide → (setBounds→attach per new view) → restore visibility →
// update bounds of already-visible views → one reorder if the attach set moved.
function emitOps<Extra>(
  desired: Map<string, DesiredView<Extra>>,
  actual: Map<string, ActualView<Extra>>,
  buckets: Buckets,
  ops: ViewOp<Extra>[],
  attachSetChanged: boolean,
): void {
  for (const id of buckets.hides) ops.push({ kind: 'setVisible', viewId: id, visible: false })
  buckets.shows.sort((a, b) => (desired.get(a)?.layer ?? 0) - (desired.get(b)?.layer ?? 0))
  for (const id of buckets.shows) {
    ops.push(setBoundsOp(id, desired.get(id)!))
    ops.push({ kind: 'attach', viewId: id })
  }
  for (const id of buckets.restores) ops.push({ kind: 'setVisible', viewId: id, visible: true })
  for (const id of buckets.updates) ops.push(setBoundsOp(id, desired.get(id)!))
  if (attachSetChanged) ops.push({ kind: 'reorder', order: computeOrder(actual, desired) })
}

export function reconcile<Extra = unknown>(
  prev: ReconcilerState<Extra>,
  snapshot: PlacementSnapshot<Extra>,
): { state: ReconcilerState<Extra>; ops: ViewOp<Extra>[] } {
  // Reject a snapshot from an OLDER generation outright. Main assigns strictly
  // monotonic per-renderer generations, so a lower generation is a late in-flight
  // snapshot from a previous renderer lifetime; honoring it would let it poison
  // lastEpoch/actual AFTER a higher-generation reset already landed (e.g. a
  // pre-reload frame arriving on the same wc after reload bumped the generation).
  if (snapshot.generation < prev.generation) {
    return { state: { ...prev }, ops: [] }
  }

  // Reject a stale snapshot (same generation, epoch not advanced) without
  // touching desired/actual. New object so callers never alias prev.
  if (snapshot.generation === prev.generation && snapshot.epoch <= prev.lastEpoch) {
    return { state: { ...prev }, ops: [] }
  }

  // `prev.actual` reflects REAL applied native-view state (main re-injects its
  // own applied-view ledger before every call — see PlacementReconciler), and
  // must carry forward across a generation bump too: a fresh renderer's first
  // snapshot may omit (or not yet redeclare) a view the previous renderer
  // lifetime actually attached — a crash, a full reload, or simply a snapshot
  // that hasn't gotten around to redeclaring it yet. `scanDetached` below can
  // only emit a `detach` op for an id it can still see in `actual`; wiping the
  // map here would silently strand that view attached forever.
  const actual = new Map<string, ActualView<Extra>>(prev.actual)

  const desired = new Map<string, DesiredView<Extra>>()
  for (let i = 0; i < snapshot.views.length; i++) {
    const v = snapshot.views[i]!
    desired.set(v.viewId, v)
  }

  const ops: ViewOp<Extra>[] = []
  let attachSetChanged = scanDetached(actual, desired, ops)

  const buckets: Buckets = { hides: [], shows: [], restores: [], updates: [] }
  for (const [id, dv] of desired) {
    if (classifyView(id, dv, actual, buckets)) attachSetChanged = true
  }

  emitOps(desired, actual, buckets, ops, attachSetChanged)

  return {
    state: {
      generation: snapshot.generation,
      lastEpoch: snapshot.epoch,
      desired,
      actual,
    },
    ops,
  }
}
