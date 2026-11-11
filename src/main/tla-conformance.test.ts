import { describe, expect, it } from 'vitest'
import { createScope, type Scope } from './scope.js'
import { createTrustSet } from '../internal/trust-set.js'
import {
	reconcile,
	createInitialState,
	type DesiredView,
	type PlacementSnapshot,
} from '../layout/placement-reconcile.js'
import { WireTransport, DECK_CODE, type MinimalIpcMain } from '../internal/wire-transport.js'
import type { InvokeFailure, InvokeResponse } from '../shared/protocol.js'
import { EventBus } from '../internal/event-bus.js'

/**
 * Model-Based Property & Conformance Testing for electron-deck.
 *
 * Asserts runtime adherence to formal TLA+ specifications:
 *   - ScopeHierarchy.tla (SingleParent, ParentChildConsistency, AcyclicOwnership, DeadNeverRevives, ResourceConservation)
 *   - TrustLeaseGate.tla (RefCountExact, ClosedScopeHasNoLeases, SecurityGateSoundness, FanoutSafety)
 *   - DeckPlacementReconciler.tla (MonotonicProgress, NoOrphanedViews, ConsistentVisibility)
 */

describe('TLA+ Conformance: ScopeHierarchy.tla', () => {
	it('enforces SingleParent, AcyclicOwnership, DeadNeverRevives, and ResourceConservation', async () => {
		const root = createScope()
		const scopes: Scope[] = [root]
		const disposedResources = new Set<string>()

		const makeResource = (name: string) => ({
			name,
			dispose: () => {
				disposedResources.add(name)
			},
		})

		// 1. Build a multi-level hierarchy
		const s1 = root.child()
		const s2 = root.child()
		const s1_child = s1.child()
		scopes.push(s1, s2, s1_child)

		// Bind resources
		s1.own(makeResource('r1'))
		s2.own(makeResource('r2'))
		s1_child.own(makeResource('r1_child'))

		expect(s1.alive).toBe(true)
		expect(s2.alive).toBe(true)
		expect(s1_child.alive).toBe(true)

		// 2. Invariant AcyclicOwnership: adopt cannot create a cycle
		// s1 cannot be adopted under s1_child (s1_child is a descendant of s1)
		await expect(root.adopt(s1, s1_child)).rejects.toThrow('would create a cycle')
		// s1 cannot adopt itself
		await expect(root.adopt(s1, s1)).rejects.toThrow('would create a cycle')

		// 3. Valid adopt: move s1_child from s1 to s2
		await s1.adopt(s1_child, s2)
		expect(s1_child.alive).toBe(true)
		expect(disposedResources.has('r1_child')).toBe(false)

		// 4. Reset on s1: soft reuse disposes s1's segment without affecting s1_child
		await s1.reset()
		expect(s1.alive).toBe(true)
		expect(disposedResources.has('r1')).toBe(true)
		expect(disposedResources.has('r1_child')).toBe(false)
		expect(s1_child.alive).toBe(true)

		// 5. In-flight reset: own() and child() during reset enter fresh segment and survive
		const sReset = root.child()
		sReset.own(makeResource('r_old'))
		const resetPromise = sReset.reset()

		// These land in the fresh segment while reset is in-flight:
		sReset.own(makeResource('r_fresh'))
		const subFresh = sReset.child()
		subFresh.own(makeResource('r_sub_fresh'))

		await resetPromise
		expect(disposedResources.has('r_old')).toBe(true)
		expect(disposedResources.has('r_fresh')).toBe(false)
		expect(disposedResources.has('r_sub_fresh')).toBe(false)
		expect(subFresh.alive).toBe(true)

		// 6. Upgrade in-flight reset to close: verifies cleanup of both old and fresh leftover segments
		const s3 = root.child()
		s3.own(makeResource('r3_initial'))
		const resetPromise3 = s3.reset()
		// Registered during reset (into the fresh segment):
		s3.own(makeResource('r3_mid_reset'))

		let closeCompleted = false
		const closePromise3 = s3.close().then(() => {
			closeCompleted = true
		})
		expect(s3.alive).toBe(false) // synchronously marked dead
		await Promise.all([resetPromise3, closePromise3])
		expect(closeCompleted).toBe(true)
		// Both the initial segment and the mid-reset segment resources must be disposed!
		expect(disposedResources.has('r3_initial')).toBe(true)
		expect(disposedResources.has('r3_mid_reset')).toBe(true)

		// 7. Invariant DeadNeverRevives: own() on dead scope immediately disposes
		let lateDisposed = false
		s3.own({
			dispose: () => {
				lateDisposed = true
			},
		})
		expect(lateDisposed).toBe(true)

		// 8. Cascade teardown on root
		await root.close()
		expect(root.alive).toBe(false)
		expect(s2.alive).toBe(false)
		expect(s1_child.alive).toBe(false)
		expect(subFresh.alive).toBe(false)
		expect(disposedResources.has('r2')).toBe(true)
		expect(disposedResources.has('r1_child')).toBe(true)
		expect(disposedResources.has('r_fresh')).toBe(true)
		expect(disposedResources.has('r_sub_fresh')).toBe(true)
	})
})

describe('TLA+ Conformance: TrustLeaseGate.tla', () => {
	it('enforces RefCountExact, ClosedScopeHasNoLeases, SecurityGateSoundness, and FanoutSafety', async () => {
		const trust = createTrustSet()
		const root = createScope()
		const s1 = root.child()
		const s2 = root.child()

		let wc1Received = 0
		let wc2Received = 0
		const wc1 = {
			id: 101,
			isDestroyed: () => false,
			send: () => {
				wc1Received++
			},
		}
		const wc2 = {
			id: 102,
			isDestroyed: () => false,
			send: () => {
				wc2Received++
			},
		}

		// Initially untrusted
		expect(trust.isTrusted(wc1.id)).toBe(false)
		expect(trust.isTrusted(wc2.id)).toBe(false)
		expect(trust.snapshot().length).toBe(0)

		// 1. Admit leases across scopes
		const lease1_s1 = trust.admit(wc1, s1)
		const _lease1_s2 = trust.admit(wc1, s2)
		const _lease2_s1 = trust.admit(wc2, s1)
		const lease2_s2 = trust.admit(wc2, s2)

		// Invariant: RefCountExact
		expect(trust.isTrusted(wc1.id)).toBe(true)
		expect(trust.isTrusted(wc2.id)).toBe(true)
		expect(trust.snapshot()).toEqual(expect.arrayContaining([wc1, wc2]))

		// 2. Early dispose on lease1_s1 (idempotent)
		lease1_s1.dispose()
		lease1_s1.dispose()
		expect(trust.isTrusted(wc1.id)).toBe(true)

		// 3. Teardown scope s2: must revoke all leases owned by s2
		await s2.close()
		expect(trust.isTrusted(wc1.id)).toBe(false) // lease1_s2 revoked -> 0
		expect(trust.isTrusted(wc2.id)).toBe(true) // lease2_s1 from s1 still active!

		// 4. Resurrecting prevention: late dispose on already revoked lease2_s2 MUST NOT mis-decrement lease2_s1
		lease2_s2.dispose()
		expect(trust.isTrusted(wc2.id)).toBe(true)

		// 5. Reset on s1: revokes leases while scope stays alive
		const wc3 = { id: 103, isDestroyed: () => false, send: () => {} }
		const _lease3_s1 = trust.admit(wc3, s1)
		expect(trust.isTrusted(wc3.id)).toBe(true)
		await s1.reset()
		expect(s1.alive).toBe(true)
		expect(trust.isTrusted(wc2.id)).toBe(false)
		expect(trust.isTrusted(wc3.id)).toBe(false)
		expect(trust.snapshot().length).toBe(0)

		// 6. WireTransport Gate testing: SecurityGateSoundness & FanoutSafety
		const bus = new EventBus()
		type IpcHandler = (
			event: { sender: { id: number; mainFrame?: { routingId: number; processId: number } | null }; senderFrame?: { routingId: number; processId: number } | null },
			...args: unknown[]
		) => unknown | Promise<unknown>

		const handlersRegistered: Record<string, IpcHandler> = {}
		const fakeIpcMain: MinimalIpcMain = {
			handle: (ch: string, fn: IpcHandler) => {
				handlersRegistered[ch] = fn
			},
			removeHandler: (ch: string) => {
				delete handlersRegistered[ch]
			},
		}

		const wire = new WireTransport({
			ipcMain: fakeIpcMain,
			bus,
			senderPolicy: trust,
			trustedWebContents: () => trust.snapshot(),
			invokeHost: async () => 'OK',
			declaredEvents: () => ['test-event'],
		})
		wire.start()

		// Admit wc1 to root
		trust.admit(wc1, root)

		const invokeHandler = handlersRegistered['__electron-deck:invoke']!
		expect(invokeHandler).toBeDefined()

		// Case A: Untrusted sender rejected fail-closed
		const resUntrusted = (await invokeHandler({
			sender: { id: 999, mainFrame: { routingId: 1, processId: 1 } },
			senderFrame: { routingId: 1, processId: 1 },
		}, { v: 1, id: '1', kind: 'host', name: 'ping', args: [] })) as InvokeFailure
		expect(resUntrusted.ok).toBe(false)
		expect(resUntrusted.error.code).toBe(DECK_CODE.UntrustedSender)

		// Case B: Sub-frame on trusted wc rejected fail-closed
		const resSubFrame = (await invokeHandler({
			sender: { id: wc1.id, mainFrame: { routingId: 1, processId: 1 } },
			senderFrame: { routingId: 2, processId: 1 }, // sub-frame!
		}, { v: 1, id: '2', kind: 'host', name: 'ping', args: [] })) as InvokeFailure
		expect(resSubFrame.ok).toBe(false)
		expect(resSubFrame.error.code).toBe(DECK_CODE.UntrustedFrame)

		// Case C: Trusted sender on main-frame accepted
		const resMainFrame = (await invokeHandler({
			sender: { id: wc1.id, mainFrame: { routingId: 1, processId: 1 } },
			senderFrame: { routingId: 1, processId: 1 },
		}, { v: 1, id: '3', kind: 'host', name: 'ping', args: [] })) as InvokeResponse
		expect(resMainFrame.ok).toBe(true)

		// Case D: Fanout delivery only to trusted webContents
		bus.publish('test-event', { msg: 'hello' })
		expect(wc1Received).toBe(1)
		expect(wc2Received).toBe(0)

		wire.dispose()
		await root.close()
	})
})

describe('TLA+ Conformance: DeckPlacementReconciler.tla', () => {
	it('enforces MonotonicProgress, NoOrphanedViews, and ConsistentVisibility across chaotic sequences', () => {
		let state = createInitialState()

		const makeView = (viewId: string, visible = true, layer = 0): DesiredView => ({
			viewId,
			placement: {
				visible,
				bounds: { x: 0, y: 0, width: 100, height: 100 },
			},
			layer,
		})

		// 1. Initial snapshot (generation 1, epoch 0)
		const snap1: PlacementSnapshot = {
			generation: 1,
			epoch: 0,
			views: [makeView('v1'), makeView('v2')],
		}
		const res1 = reconcile(state, snap1)
		state = res1.state
		expect(state.generation).toBe(1)
		expect(state.lastEpoch).toBe(0)
		expect(state.actual.get('v1')?.attached).toBe(true)
		expect(state.actual.get('v2')?.attached).toBe(true)

		// 2. Reject stale epoch (generation 1, epoch 0 <= lastEpoch 0)
		const staleEpochRes = reconcile(state, snap1)
		expect(staleEpochRes.ops.length).toBe(0)
		expect(staleEpochRes.state.lastEpoch).toBe(0)

		// 3. Reject older generation (generation 0 < currentGen 1)
		const olderGenSnap: PlacementSnapshot = {
			generation: 0,
			epoch: 99,
			views: [makeView('v3')],
		}
		const olderGenRes = reconcile(state, olderGenSnap)
		expect(olderGenRes.ops.length).toBe(0)
		expect(olderGenRes.state.generation).toBe(1)

		// 4. Anti-Orphan guarantee across generation leap:
		// Generation 2 only declares v1; v2 was attached in gen 1 but omitted in gen 2!
		// Reconciler MUST carry forward actual and emit detach for v2!
		const snap2: PlacementSnapshot = {
			generation: 2,
			epoch: 0,
			views: [makeView('v1')],
		}
		const res2 = reconcile(state, snap2)
		state = res2.state
		expect(state.generation).toBe(2)
		expect(state.lastEpoch).toBe(0)
		const detachOps = res2.ops.filter((op) => op.kind === 'detach' && op.viewId === 'v2')
		expect(detachOps.length).toBe(1)
		expect(state.actual.has('v2')).toBe(false)
		expect(state.actual.get('v1')?.attached).toBe(true)

		// 5. Pseudo-random stress sequence asserting TLA+ invariants across 100 iterations
		// Uses Linear Congruential Generator for reproducible pseudo-random chaotic inputs
		let prngState = 0x12345678
		const nextRandom = () => {
			prngState = (Math.imul(prngState, 1664525) + 1013904223) >>> 0
			return prngState / 4294967296
		}

		const viewPool = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
		let gen = 2
		let epoch = 0

		for (let step = 0; step < 100; step++) {
			const actionRoll = nextRandom()
			let snapGen = gen
			let snapEpoch = epoch

			if (actionRoll < 0.15) {
				// Generation jump
				gen++
				epoch = 0
				snapGen = gen
				snapEpoch = epoch
			} else if (actionRoll < 0.35) {
				// Normal epoch increment
				epoch++
				snapGen = gen
				snapEpoch = epoch
			} else if (actionRoll < 0.5) {
				// Stale / duplicate epoch
				snapEpoch = Math.max(0, epoch - 1)
			} else if (actionRoll < 0.6) {
				// Older generation
				snapGen = Math.max(0, gen - 1)
			} else {
				epoch++
				snapGen = gen
				snapEpoch = epoch
			}

			// Random subset of active views
			const viewsInSnap: DesiredView[] = []
			for (const vId of viewPool) {
				if (nextRandom() > 0.4) {
					const isVis = nextRandom() > 0.3
					const layer = Math.floor(nextRandom() * 3)
					viewsInSnap.push(makeView(vId, isVis, layer))
				}
			}

			const isStale =
				snapGen < state.generation ||
				(snapGen === state.generation && snapEpoch <= state.lastEpoch)

			const prevGen = state.generation
			const prevEpoch = state.lastEpoch

			const outcome = reconcile(state, {
				generation: snapGen,
				epoch: snapEpoch,
				views: viewsInSnap,
			})
			state = outcome.state

			if (isStale) {
				expect(outcome.ops.length).toBe(0)
				expect(state.generation).toBe(prevGen)
				expect(state.lastEpoch).toBe(prevEpoch)
			} else {
				// Invariant: MonotonicProgress
				const genProgressed = state.generation > prevGen
				const epochProgressed =
					state.generation === prevGen && state.lastEpoch >= prevEpoch
				expect(genProgressed || epochProgressed).toBe(true)

				// Invariant: NoOrphanedViews
				const declaredIds = new Set(viewsInSnap.map((v) => v.viewId))
				for (const [viewId, actual] of state.actual.entries()) {
					if (actual.attached) {
						expect(declaredIds.has(viewId)).toBe(true)
					}
				}

				// Invariant: ConsistentVisibility
				for (const actual of state.actual.values()) {
					if (actual.visible) {
						expect(actual.attached).toBe(true)
					}
				}
			}
		}
	})
})
