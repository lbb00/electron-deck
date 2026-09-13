import type { DesiredView, PlacementSnapshot } from '../layout/index.js'

// Renderer-side single source of truth for native-view placement. Every anchor
// writes its view's desired placement here instead of invoking IPC directly; a
// central scheduler reads the WHOLE table once after the current render step
// and publishes one window-level snapshot (a monotonic epoch shared by all
// views in the tick).
//
// Coalescing a level stream is safe: many set()/remove() calls in one frame
// collapse to the latest level, so a transient (e.g. a relayout that momentarily
// measures 0×0 then restores) is overwritten before it is ever published. This
// is what a per-view edge stream cannot do — it is the producer half of the
// reconcile design (see ../layout/placement-reconcile.ts).

export interface PlacementPublisherDeps<Extra = unknown> {
  // Renderer lifetime id stamped on every snapshot; a fresh renderer uses a
  // higher generation than the last one main accepted, so main's
  // lower-generation guard doesn't reject its snapshots. A function is
  // re-read on EVERY flush, so a host whose generation is assigned by main (via a
  // grant that can arrive after the publisher is created) can hand a getter and
  // have later snapshots pick up the newer value.
  generation: number | (() => number)
  publish: (snapshot: PlacementSnapshot<Extra>) => void
  // Injectable for tests; default to a MessageChannel-based post-task (see
  // createDefaultScheduler below).
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
}

export interface PlacementPublisher<Extra = unknown> {
  // Upsert one view's desired placement and schedule a coalesced publish.
  set(view: DesiredView<Extra>): void
  // Drop a view from the desired table and schedule a coalesced publish.
  remove(viewId: string): void
  // End this source of truth: cancel any pending frame and synchronously
  // publish one final EMPTY snapshot (the death of the publisher is itself a
  // level — nothing is desired), so a level-triggered consumer releases every
  // view this publisher placed. Idempotent; set()/remove() are no-ops after.
  dispose(): void
}

export function createPlacementPublisher<Extra = unknown>(
  deps: PlacementPublisherDeps<Extra>,
): PlacementPublisher<Extra> {
  // Frame ids belong to the scheduler that generated them. A custom request
  // without its matching cancel must keep its custom scheduling semantics, but
  // cannot be cancelled through the default scheduler: identical numeric ids
  // could otherwise cancel another publisher's task. dispose()'s guard makes
  // a later callback harmless, so a no-op cancel is the safe fallback. A
  // cancel-only injection is ignored because its scheduler did not issue the id.
  const defaultScheduler = getDefaultScheduler()
  const requestFrame = deps.requestFrame ?? defaultScheduler.request
  const cancelFrame = deps.requestFrame === undefined ? defaultScheduler.cancel : (deps.cancelFrame ?? ((): void => {}))
  const readGeneration =
    typeof deps.generation === 'function' ? deps.generation : (): number => deps.generation as number

  const views = new Map<string, DesiredView<Extra>>()
  let dirty = false
  let frameId: number | null = null
  // `armed` is set the instant a frame is requested, before requestFrame()
  // returns — so a requestFrame that invokes its callback SYNCHRONOUSLY
  // (as an injected test double may) still sees the schedule as taken and
  // won't recurse. `frameId` alone can't do this: flush() clears it to null
  // BEFORE schedule()'s `frameId = requestFrame(flush)` assignment lands,
  // so that assignment would stomp it back to non-null forever, silently
  // wedging every future set()/remove() as "already scheduled".
  let armed = false
  let epoch = 0
  let disposed = false

  function schedule(): void {
    if (disposed || armed) return
    armed = true
    let id: number
    try {
      id = requestFrame(flush)
    } catch (error) {
      // A scheduler failure must leave the dirty level available for retry.
      if (frameId === null) armed = false
      throw error
    }
    // flush() may already have run synchronously and cleared `armed`; only
    // record the frame id if the frame is still actually pending.
    if (armed && frameId === null) frameId = id
  }

  function flush(): void {
    armed = false
    frameId = null
    // A frame that fires with nothing dirty (or after dispose) publishes
    // nothing — coalescing means only a real change reaches the wire.
    if (disposed || !dirty) return
    dirty = false
    const count = views.size
    const viewList: DesiredView<Extra>[] = new Array(count)
    let idx = 0
    for (const v of views.values()) {
      viewList[idx++] = v
    }
    deps.publish({
      generation: readGeneration(),
      epoch: epoch++,
      views: viewList,
    })
  }

  return {
    set(view: DesiredView<Extra>): void {
      if (disposed) return
      views.set(view.viewId, view)
      dirty = true
      schedule()
    },
    remove(viewId: string): void {
      if (disposed) return
      // Removing an absent id is not a change — don't arm a redundant frame.
      if (!views.delete(viewId)) return
      dirty = true
      schedule()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (armed) {
        if (frameId !== null) cancelFrame(frameId)
        armed = false
        frameId = null
      }
      // The publisher is the renderer-side source of truth for desired
      // placement, and the main-side reconciler is level-triggered: it keeps
      // applying whatever level it last received. The source of truth dying is
      // itself a level — nothing is desired anymore — so flush one final empty
      // snapshot synchronously. Without it the last non-empty snapshot stays
      // frozen in main and every view it placed survives its owner (e.g. a
      // host toolbar strip overlaying the page that replaces the unmounted
      // one). The epoch stays monotonic so the reconciler can't reject the
      // flush as stale; a late flush from an old renderer generation is
      // rejected by the reconciler's generation guard, so racing a successor
      // publisher is safe.
      deps.publish({
        generation: readGeneration(),
        epoch: epoch++,
        views: [],
      })
    },
  }
}

// Default scheduler: a MessageChannel-based post-task, not rAF.
//
// set()/remove() are called from view-anchor's ResizeObserver callback, which
// the browser runs inside the "update the rendering" steps of the current
// frame. A rAF callback requested from there belongs to the NEXT frame, so
// rAF coalescing delays the publish by a whole frame — measured as ~17 ms of
// native-view lag behind the DOM slot during a split drag. A message posted
// from inside the rendering steps runs as the next task, right after this
// frame's rendering steps finish: every set()/remove() of the step is still
// coalesced into one publish, but nothing waits for another frame (measured
// lag ~1 ms).
//
// One scheduler instance is shared by every publisher using the default; ids
// are namespaced by this scheduler, not by caller.
function createDefaultScheduler(): {
  request: (cb: () => void) => number
  cancel: (id: number) => void
} {
  if (typeof globalThis.MessageChannel === 'function') {
    const channel = new MessageChannel()
    const queue: number[] = []
    const callbacks = new Map<number, () => void>()
    let nextId = 1
    channel.port1.onmessage = (): void => {
      const id = queue.shift()
      if (id === undefined) return
      const cb = callbacks.get(id)
      // Absent means cancel() already ran for this id — skip, don't throw.
      if (cb === undefined) return
      callbacks.delete(id)
      cb()
    }
    // Assigning onmessage automatically refs a Node port, so unref afterward.
    ;(channel.port1 as { unref?: () => void }).unref?.()
    return {
      request(cb: () => void): number {
        const id = nextId++
        callbacks.set(id, cb)
        queue.push(id)
        channel.port2.postMessage(null)
        return id
      },
      cancel(id: number): void {
        callbacks.delete(id)
      },
    }
  }
  // Environments with no MessageChannel (unusual; some minimal test/SSR
  // runtimes) fall back to a plain macrotask.
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextId = 1
  return {
    request(cb: () => void): number {
      const id = nextId++
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        cb()
      }, 0))
      return id
    },
    cancel(id: number): void {
      const timer = timers.get(id)
      if (timer === undefined) return
      clearTimeout(timer)
      timers.delete(id)
    },
  }
}

let defaultScheduler: ReturnType<typeof createDefaultScheduler> | undefined
function getDefaultScheduler(): ReturnType<typeof createDefaultScheduler> {
  defaultScheduler ??= createDefaultScheduler()
  return defaultScheduler
}
