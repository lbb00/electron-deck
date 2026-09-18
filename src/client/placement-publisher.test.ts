import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPlacementPublisher } from './placement-publisher.js'
import type { DesiredView, PlacementSnapshot } from '../layout/index.js'

// Fake rAF scheduler — drives frame delivery without real timers.
class FakeRaf {
  private cbs = new Map<number, () => void>()
  private nextId = 1
  request = vi.fn((cb: () => void): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  })
  cancel = vi.fn((id: number): void => {
    this.cbs.delete(id)
  })
  /** Drain exactly the callbacks pending at call-time; re-requests land in next flush. */
  flushFrame(): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb()
  }
  get pending(): number {
    return this.cbs.size
  }
}

// Helpers for building test fixtures.
function makeView(viewId: string, visible = true): DesiredView {
  return {
    viewId,
    layer: 0,
    placement: visible
      ? { visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } }
      : { visible: false },
  }
}

describe('createPlacementPublisher', () => {
  let raf: FakeRaf
  // A typed-impl mock: it stays assignable to the `(snapshot) => void` deps
  // field (unlike an impl-less `vi.fn()`, whose type carries a construct
  // signature) AND records each published snapshot in a typed array so
  // assertions read well-typed values instead of `mock.calls`'s `any[][]`.
  const snapshots: PlacementSnapshot[] = []
  const publish = vi.fn((snap: PlacementSnapshot): void => {
    snapshots.push(snap)
  })
  const nthSnapshot = (n: number): PlacementSnapshot => {
    const snap = snapshots[n]
    if (!snap) throw new Error(`no published snapshot at index ${n}`)
    return snap
  }

  beforeEach(() => {
    raf = new FakeRaf()
    snapshots.length = 0
    publish.mockClear()
  })

  // ── Contract 1: frame-coalesced publish ──────────────────────────────────

  describe('frame-coalesced publish', () => {
    it('does not publish synchronously after set', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      expect(publish).not.toHaveBeenCalled()
    })

    it('publishes on the next frame after set', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toHaveLength(1)
      expect(snap.views[0]!.viewId).toBe('a')
    })
  })

  // ── Contract 2: same-frame coalescing ────────────────────────────────────

  describe('same-frame coalescing', () => {
    it('collapses multiple set calls for the same viewId to the last value', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      const first = makeView('a')
      const last: DesiredView = {
        viewId: 'a',
        layer: 5,
        placement: { visible: false },
      }
      publisher.set(first)
      publisher.set(last)
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toHaveLength(1)
      expect(snap.views[0]!.layer).toBe(5)
      expect(snap.views[0]!.placement.visible).toBe(false)
    })

    it('merges different viewIds from the same frame into one snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      const ids = snap.views.map((v) => v.viewId).sort()
      expect(ids).toEqual(['a', 'b'])
    })

    it('only calls schedulePublish once per dirty frame regardless of set call count', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      publisher.set(makeView('a'))
      expect(raf.request).toHaveBeenCalledOnce()
    })
  })

  // ── Contract 3: remove ───────────────────────────────────────────────────

  describe('remove', () => {
    it('excludes a removed viewId from the next published snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      raf.flushFrame()
      snapshots.length = 0
      publish.mockClear()

      publisher.remove('a')
      raf.flushFrame()
      const snap = nthSnapshot(0)
      const ids = snap.views.map((v) => v.viewId)
      expect(ids).not.toContain('a')
      expect(ids).toContain('b')
    })

    it('schedules a publish when remove is called with an existing viewId', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      publish.mockClear()

      publisher.remove('a')
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
    })
  })

  // ── Contract 4: dirty gate ───────────────────────────────────────────────

  describe('dirty gate', () => {
    it('does not publish when a frame fires with no pending changes', () => {
      createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      // No set/remove calls — flush should be a no-op.
      raf.flushFrame()
      expect(publish).not.toHaveBeenCalled()
    })

    it('does not publish on subsequent frames after an already-published snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      publish.mockClear()

      // No more changes — another frame should not re-publish.
      raf.flushFrame()
      expect(publish).not.toHaveBeenCalled()
    })
  })

  // ── Contract 5: epoch monotonicity ──────────────────────────────────────

  describe('epoch monotonicity', () => {
    it('publishes with epoch 0 on the first frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).epoch).toBe(0)
    })

    it('increments epoch strictly on each successive publish', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      const firstEpoch = nthSnapshot(0).epoch

      publisher.set(makeView('b'))
      raf.flushFrame()
      const secondEpoch = nthSnapshot(1).epoch

      expect(secondEpoch).toBeGreaterThan(firstEpoch)
    })
  })

  // ── Contract 6: generation pass-through ─────────────────────────────────

  describe('generation pass-through', () => {
    it('stamps every snapshot with the generation value from deps', () => {
      const publisher = createPlacementPublisher({
        generation: 42,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(42)
    })

    it('stamps the same generation across multiple frames', () => {
      const publisher = createPlacementPublisher({
        generation: 7,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(snapshots.length).toBeGreaterThan(0)
      for (const snap of snapshots) {
        expect(snap.generation).toBe(7)
      }
    })
  })

  // ── Contract 7: dispose ──────────────────────────────────────────────────

  describe('dispose', () => {
    it('calls cancelScheduledPublish for the pending frame when disposed', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      expect(raf.pending).toBe(1)
      publisher.dispose()
      expect(raf.cancel).toHaveBeenCalled()
    })

    it('does not cancel another publisher\'s default task when only schedulePublish is injected', async () => {
      // Scheduler ids are meaningful only to the scheduler that issued them.
      // A partial override must therefore not pair its id with the shared
      // default cancel function: this publisher's dispose used to cancel the
      // first publisher's pending default task when both happened to use id 1.
      const defaultPublish = vi.fn()
      const defaultPublisher = createPlacementPublisher({ generation: 1, publish: defaultPublish })
      let partialCallback: (() => void) | undefined
      const partialRequest = vi.fn((callback: () => void) => {
        partialCallback = callback
        return 1
      })
      const partialPublisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: partialRequest,
      })

      defaultPublisher.set(makeView('default'))
      partialPublisher.set(makeView('partial'))
      partialPublisher.dispose()

      await vi.waitFor(() => expect(defaultPublish).toHaveBeenCalledOnce())
      expect(partialRequest).toHaveBeenCalledOnce()
      partialCallback?.()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('does not pass a default task id to an unmatched cancelScheduledPublish', () => {
      const unrelatedCancel = vi.fn()
      const publisher = createPlacementPublisher({ generation: 1, publish, cancelScheduledPublish: unrelatedCancel })
      publisher.set(makeView('a'))
      publisher.dispose()
      expect(unrelatedCancel).not.toHaveBeenCalled()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('flushes exactly one empty snapshot when disposed, even with no prior set() calls', () => {
      // The renderer-side publisher is the single source of truth for a
      // native view's desired placement; main's reconciler is level-triggered
      // and keeps applying whatever it last received. If dispose() only
      // cancels the pending frame without publishing anything, the last
      // truthful snapshot (or "nothing was ever set") stays frozen in main
      // forever — a host toolbar view stays attached+visible after the
      // renderer that owned it is gone. Death of the source of truth must
      // itself publish as a level: empty.
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toEqual([])
      expect(snap.generation).toBe(1)
    })

    it('re-reads a function-form generation for the dispose flush', () => {
      let currentGen = 5
      const publisher = createPlacementPublisher({
        generation: () => currentGen,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      currentGen = 11
      publisher.dispose()
      expect(nthSnapshot(0).generation).toBe(11)
    })

    it('stamps the dispose flush with an epoch strictly greater than any prior publish', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      const priorEpoch = nthSnapshot(0).epoch

      publisher.dispose()
      expect(publish).toHaveBeenCalledTimes(2)
      expect(nthSnapshot(1).epoch).toBeGreaterThan(priorEpoch)
    })

    it('does not publish again when the pre-dispose frame callback fires after dispose', () => {
      // Capture the callback before disposal so we can call it manually,
      // simulating a rAF callback that was already queued by the platform
      // and fires despite cancelScheduledPublish having been invoked.
      let captured: (() => void) | undefined
      const customRequest = vi.fn((cb: () => void): number => {
        captured = cb
        return 1
      })
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: customRequest,
        cancelScheduledPublish: vi.fn(),
      })
      publisher.set(makeView('a'))
      publisher.dispose()
      // dispose() already flushed the final empty snapshot synchronously.
      expect(publish).toHaveBeenCalledOnce()
      expect(nthSnapshot(0).views).toEqual([])

      // A stale pre-dispose frame firing afterward must not publish again.
      captured?.()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('does not publish again after dispose even when set is called and a frame fires', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()

      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('is idempotent: a second dispose() call does not publish again', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()

      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('ignores set()/remove() calls after dispose without scheduling a frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.dispose()
      raf.request.mockClear()

      publisher.set(makeView('a'))
      publisher.remove('a')
      expect(raf.request).not.toHaveBeenCalled()
    })
  })

  // ── Contract 8: coalescing does not span frames ──────────────────────────

  describe('cross-frame independence', () => {
    it('publishes independently on each frame when set is called between flushes', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })

      // Frame 1
      publisher.set(makeView('a'))
      raf.flushFrame()

      // Frame 2
      publisher.set(makeView('b'))
      raf.flushFrame()

      expect(publish).toHaveBeenCalledTimes(2)
    })

    it('re-arms the scheduler after each frame so the next set triggers a new frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(raf.request).toHaveBeenCalledTimes(1)

      publisher.set(makeView('b'))
      // A second schedulePublish call must have been made.
      expect(raf.request).toHaveBeenCalledTimes(2)
    })
  })

  // ── Contract 9: generation as a function ─────────────────────────────────

  describe('generation as a function', () => {
    it('re-reads the function on every flush so a later grant can bump the generation', () => {
      let currentGen = 3
      const publisher = createPlacementPublisher({
        generation: () => currentGen,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })

      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(3)

      currentGen = 8
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(nthSnapshot(1).generation).toBe(8)
    })

    it('a constant number generation still works as before (regression guard)', () => {
      const publisher = createPlacementPublisher({
        generation: 99,
        publish,
        schedulePublish: raf.request,
        cancelScheduledPublish: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(99)
    })
  })

  // ── Contract 10: reentrant scheduling (synchronous schedulePublish) ────────
  //
  // A synchronous schedulePublish runs flush() INSIDE the call that requests it.
  // The scheduler must not treat the frame it just consumed as still pending,
  // or every later set()/remove() would be dropped as "already scheduled".

  describe('reentrant scheduling with a synchronous schedulePublish', () => {
    it('publishes separately for two set() calls that each synchronously flush', () => {
      const sync = vi.fn((cb: () => void): number => {
        cb()
        return 0
      })
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        schedulePublish: sync,
        cancelScheduledPublish: vi.fn(),
      })

      publisher.set(makeView('a'))
      expect(publish).toHaveBeenCalledTimes(1)

      publisher.set(makeView('b'))
      // The second set() must schedule (and here, immediately run) a new flush.
      expect(publish).toHaveBeenCalledTimes(2)
      const ids = nthSnapshot(1).views.map((v) => v.viewId).sort()
      expect(ids).toEqual(['a', 'b'])
    })
  })

  it('retries scheduling after an injected scheduler throws', () => {
    const request = vi.fn()
      .mockImplementationOnce(() => { throw new Error('scheduler unavailable') })
      .mockImplementationOnce(raf.request)
    const publisher = createPlacementPublisher({
      generation: 1,
      publish,
      schedulePublish: request,
      cancelScheduledPublish: raf.cancel,
    })

    expect(() => publisher.set(makeView('a'))).toThrow('scheduler unavailable')
    publisher.set(makeView('b'))
    raf.flushFrame()
    expect(publish).toHaveBeenCalledOnce()
    expect(nthSnapshot(0).views.map((v) => v.viewId)).toEqual(['a', 'b'])
  })

  // ── Contract 11: default scheduler (MessageChannel post-task) ───────────
  //
  // With no schedulePublish/cancelScheduledPublish injected, the publisher falls back to
  // its own MessageChannel-based scheduler — available in vitest's node
  // environment — instead of requestAnimationFrame.

  describe('default scheduler', () => {
    it('does not keep a Node process alive after installing its message handler', async () => {
      const NativeMessageChannel = globalThis.MessageChannel
      let receivingPort: { hasRef(): boolean } | undefined
      class TrackedMessageChannel extends NativeMessageChannel {
        constructor() {
          super()
          receivingPort = this.port1 as unknown as { hasRef(): boolean }
        }
      }
      vi.stubGlobal('MessageChannel', TrackedMessageChannel)
      vi.resetModules()
      let publisher: ReturnType<typeof createPlacementPublisher> | undefined
      try {
        const { createPlacementPublisher: createFreshPublisher } = await import('./placement-publisher.js')
        publisher = createFreshPublisher({ generation: 1, publish })
        publisher.set(makeView('a'))
        expect(receivingPort?.hasRef()).toBe(false)
      } finally {
        publisher?.dispose()
        vi.unstubAllGlobals()
      }
    })

    it('coalesces three same-tick set() calls into exactly one publish after a macrotask', async () => {
      const publisher = createPlacementPublisher({ generation: 1, publish })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      publisher.set(makeView('c'))
      expect(publish).not.toHaveBeenCalled()

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(publish).toHaveBeenCalledOnce()
      const ids = nthSnapshot(0).views.map((v) => v.viewId).sort()
      expect(ids).toEqual(['a', 'b', 'c'])
    })

    it('delivers only the dispose empty snapshot when disposed right after set()', async () => {
      const publisher = createPlacementPublisher({ generation: 1, publish })
      publisher.set(makeView('a'))
      publisher.dispose()

      await new Promise((resolve) => setTimeout(resolve, 0))

      // The pending post-task from set() must not also land — dispose()'s
      // cancel must reach the default scheduler, not just an injected fake.
      expect(publish).toHaveBeenCalledOnce()
      expect(nthSnapshot(0).views).toEqual([])
    })

    it('does not publish when remove() is called for an id that was never set', async () => {
      const publisher = createPlacementPublisher({ generation: 1, publish })
      publisher.remove('never-set')

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(publish).not.toHaveBeenCalled()
    })
  })
})
