import { describe, expect, it, vi } from 'vitest'
import { EventNotBoundError } from '../errors.js'
import { defineEvent } from '../events.js'
import type { JsonValue } from '../types.js'
import { EventBus } from './event-bus.js'

/**
 * Phase 2 contract tests for the framework-internal EventBus.
 */
describe('EventBus', () => {
	it('bindDeclaredEvents wires the publisher so HostEvent.publish no longer throws', () => {
		const bus = new EventBus()
		const ev = defineEvent<JsonValue>('e1')
		bus.bindDeclaredEvents([ev])
		expect(() => ev.publish({ ok: true })).not.toThrow()
	})

	it('a HostEvent not in the declared array still throws EventNotBoundError on publish', () => {
		const bus = new EventBus()
		const declared = defineEvent<JsonValue>('declared')
		const undeclared = defineEvent<JsonValue>('undeclared')
		bus.bindDeclaredEvents([declared])
		expect(() => undeclared.publish({ x: 1 })).toThrow(EventNotBoundError)
	})

	it('bus.publish notifies all subscribers registered via subscribe()', () => {
		const bus = new EventBus()
		const a = vi.fn()
		const b = vi.fn()
		bus.subscribe('chan', a)
		bus.subscribe('chan', b)
		bus.publish('chan', { hello: 'world' })
		expect(a).toHaveBeenCalledTimes(1)
		expect(a).toHaveBeenCalledWith({ hello: 'world' })
		expect(b).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledWith({ hello: 'world' })
	})

	it('publish through a bound HostEvent reaches bus subscribers under that name', () => {
		const bus = new EventBus()
		const ev = defineEvent<JsonValue>('hello')
		bus.bindDeclaredEvents([ev])
		const listener = vi.fn()
		bus.subscribe('hello', listener)
		ev.publish({ greeting: 'hi' })
		expect(listener).toHaveBeenCalledWith({ greeting: 'hi' })
	})

	it('publish on a channel with no subscribers is a no-op (does not throw)', () => {
		const bus = new EventBus()
		expect(() => bus.publish('nobody-listening', { x: 1 })).not.toThrow()
	})

	it('subscribe returns a Disposable; dispose removes that listener', () => {
		const bus = new EventBus()
		const listener = vi.fn()
		const sub = bus.subscribe('chan', listener)
		bus.publish('chan', { n: 1 })
		expect(listener).toHaveBeenCalledTimes(1)
		sub.dispose()
		bus.publish('chan', { n: 2 })
		expect(listener).toHaveBeenCalledTimes(1) // not called after dispose
	})

	it('disposing one subscriber does not affect the others', () => {
		const bus = new EventBus()
		const a = vi.fn()
		const b = vi.fn()
		const subA = bus.subscribe('chan', a)
		bus.subscribe('chan', b)
		subA.dispose()
		bus.publish('chan', { x: 1 })
		expect(a).not.toHaveBeenCalled()
		expect(b).toHaveBeenCalledTimes(1)
	})

	it('unbindAll clears all subscribers — subsequent publish notifies no one', () => {
		const bus = new EventBus()
		const listener = vi.fn()
		bus.subscribe('chan', listener)
		bus.unbindAll()
		bus.publish('chan', { x: 1 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('unbindAll unbinds declared HostEvent publishers — publish then throws EventNotBoundError', () => {
		const bus = new EventBus()
		const ev = defineEvent<JsonValue>('to-unbind')
		bus.bindDeclaredEvents([ev])
		expect(() => ev.publish({ x: 1 })).not.toThrow()
		bus.unbindAll()
		expect(() => ev.publish({ x: 2 })).toThrow(EventNotBoundError)
	})

	it('re-binding the same HostEvent overrides the previous publisher (hot-reload)', () => {
		// Hot-reload scenario: bindDeclaredEvents called twice with the same
		// HostEvent must not throw and must replace the publisher.
		const bus1 = new EventBus()
		const bus2 = new EventBus()
		const ev = defineEvent<JsonValue>('hot-reload')
		bus1.bindDeclaredEvents([ev])
		expect(() => bus2.bindDeclaredEvents([ev])).not.toThrow()
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		bus1.subscribe('hot-reload', listener1)
		bus2.subscribe('hot-reload', listener2)
		ev.publish({ x: 1 })
		// New publisher routes to bus2.
		expect(listener2).toHaveBeenCalledTimes(1)
		expect(listener1).not.toHaveBeenCalled()
	})

	it('different channels are isolated — publish on A does not notify subscribers on B', () => {
		const bus = new EventBus()
		const listenerA = vi.fn()
		const listenerB = vi.fn()
		bus.subscribe('A', listenerA)
		bus.subscribe('B', listenerB)
		bus.publish('A', { x: 1 })
		expect(listenerA).toHaveBeenCalledTimes(1)
		expect(listenerB).not.toHaveBeenCalled()
	})

	// 重入守护。listener 内同步再 publish 同一 event 不能死循环。
	it('reentrant publish on same channel within a listener is dropped + logged', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const bus = new EventBus()
			let count = 0
			bus.subscribe('looper', () => {
				count++
				if (count < 5) bus.publish('looper', { round: count })
			})
			bus.publish('looper', { round: 0 })
			// 第一次 publish 跑 listener (count=1)，listener 内 publish 被 drop。
			expect(count).toBe(1)
			expect(errorSpy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
		}
	})

	it('different channels do not trigger reentrancy guard for each other', () => {
		const bus = new EventBus()
		const calls: string[] = []
		bus.subscribe('A', () => {
			calls.push('A')
			bus.publish('B', { fromA: true })
		})
		bus.subscribe('B', () => {
			calls.push('B')
		})
		bus.publish('A', { start: true })
		expect(calls).toEqual(['A', 'B'])
	})

	// Subscriber snapshots are cached across publish() calls and invalidated on
	// subscribe/dispose — these pin the observable contract that must survive
	// regardless of that caching.
	it('a listener that disposes itself during publish is still called this time, not next', () => {
		const bus = new EventBus()
		const calls: number[] = []
		const sub = bus.subscribe('chan', () => {
			calls.push(1)
			sub.dispose()
		})
		bus.publish('chan', { n: 1 })
		expect(calls).toHaveLength(1)
		bus.publish('chan', { n: 2 })
		expect(calls).toHaveLength(1)
	})

	it('a listener that subscribes a new listener during publish: new one skips this publish, fires next', () => {
		const bus = new EventBus()
		const newListener = vi.fn()
		bus.subscribe('chan', () => {
			bus.subscribe('chan', newListener)
		})
		bus.publish('chan', { n: 1 })
		expect(newListener).not.toHaveBeenCalled()
		bus.publish('chan', { n: 2 })
		expect(newListener).toHaveBeenCalledTimes(1)
	})

	it('subscribeAll: a listener that disposes itself during publish is still called this time, not next', () => {
		const bus = new EventBus()
		const calls: number[] = []
		const sub = bus.subscribeAll(() => {
			calls.push(1)
			sub.dispose()
		})
		bus.publish('chan', { n: 1 })
		expect(calls).toHaveLength(1)
		bus.publish('chan', { n: 2 })
		expect(calls).toHaveLength(1)
	})

	it('subscribeAll: a listener that subscribes a new all-listener during publish skips this publish, fires next', () => {
		const bus = new EventBus()
		const newListener = vi.fn()
		bus.subscribeAll(() => {
			bus.subscribeAll(newListener)
		})
		bus.publish('chan', { n: 1 })
		expect(newListener).not.toHaveBeenCalled()
		bus.publish('chan', { n: 2 })
		expect(newListener).toHaveBeenCalledTimes(1)
	})

	it('call-count sequence across subscribe → publish → dispose → publish → subscribe → publish', () => {
		const bus = new EventBus()
		const listener = vi.fn()
		const sub = bus.subscribe('chan', listener)
		bus.publish('chan', { n: 1 })
		expect(listener).toHaveBeenCalledTimes(1)
		sub.dispose()
		bus.publish('chan', { n: 2 })
		expect(listener).toHaveBeenCalledTimes(1)
		bus.subscribe('chan', listener)
		bus.publish('chan', { n: 3 })
		expect(listener).toHaveBeenCalledTimes(2)
	})
})
