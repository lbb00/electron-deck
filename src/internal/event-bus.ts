import { bindHostEvent, unbindHostEvent } from '../events.js'
import type { Disposable, HostEvent, JsonValue } from '../types.js'

/**
 * Framework-internal event bus.
 *
 * Responsibilities:
 * - `bindDeclaredEvents(events)`: during Bind, call the framework binder for each
 *   declared HostEvent so its `publish()` routes through the bus.
 * - `publish(name, payload)`: notify all listeners registered by `subscribe(name, ...)`.
 * - `subscribe(name, listener)`: return a `Disposable` that stops notifications when disposed.
 * - `unbindAll()`: unbind all declared event publishers and clear subscribers.
 *
 * @internal
 */
export class EventBus {
	private readonly subscribers = new Map<string, Set<(payload: JsonValue) => void>>()
	private readonly subscribersCache = new Map<string, readonly ((payload: JsonValue) => void)[]>()
	private readonly allSubscribers = new Set<(name: string, payload: JsonValue) => void>()
	private allSubscribersCache: readonly ((name: string, payload: JsonValue) => void)[] | null = null
	private readonly inFlight = new Set<string>()
	private boundEvents: HostEvent<JsonValue>[] = []

	bindDeclaredEvents(events: readonly HostEvent<JsonValue>[]): void {
		for (const ev of events) {
			bindHostEvent(ev, (payload: JsonValue) => this.publish(ev.name, payload))
			this.boundEvents.push(ev)
		}
	}

	publish(name: string, payload: JsonValue): void {
		// A listener synchronously republishing the same event can recurse indefinitely.
		// Log and drop reentrant publishes without throwing, so the active listener
		// chain keeps its fire-and-forget behavior.
		if (this.inFlight.has(name)) {
			console.error(`[electron-deck] reentrant publish on "${name}" dropped (listener republished the same event synchronously)`)
			return
		}
		this.inFlight.add(name)
		try {
			const subs = this.subscribers.get(name)
			if (subs && subs.size > 0) {
				// Snapshot listeners so disposal during delivery does not affect iteration; cache it to avoid allocating an array on every publish.
				let snapshot = this.subscribersCache.get(name)
				if (snapshot === undefined) {
					snapshot = Array.from(subs)
					this.subscribersCache.set(name, snapshot)
				}
				for (let i = 0; i < snapshot.length; i++) {
					try {
						snapshot[i]!(payload)
					}
					catch (e) {
						console.error(`[electron-deck] subscriber for "${name}" threw:`, e)
					}
				}
			}
			if (this.allSubscribers.size > 0) {
				let snapshot = this.allSubscribersCache
				if (snapshot === null) {
					snapshot = Array.from(this.allSubscribers)
					this.allSubscribersCache = snapshot
				}
				for (let i = 0; i < snapshot.length; i++) {
					try {
						snapshot[i]!(name, payload)
					}
					catch (e) {
						console.error(`[electron-deck] catch-all subscriber threw on "${name}":`, e)
					}
				}
			}
		}
		finally {
			this.inFlight.delete(name)
		}
	}

	subscribe(name: string, listener: (payload: JsonValue) => void): Disposable {
		let subs = this.subscribers.get(name)
		if (!subs) {
			subs = new Set()
			this.subscribers.set(name, subs)
		}
		subs.add(listener)
		this.subscribersCache.delete(name)
		const set = subs
		return {
			dispose: () => {
				set.delete(listener)
				this.subscribersCache.delete(name)
			},
		}
	}

	/**
	 * Subscribe to publishes on every channel. The framework wire transport uses this
	 * to bridge declared HostEvent.publish() calls to webContents.send.
	 */
	subscribeAll(listener: (name: string, payload: JsonValue) => void): Disposable {
		this.allSubscribers.add(listener)
		this.allSubscribersCache = null
		return {
			dispose: () => {
				this.allSubscribers.delete(listener)
				this.allSubscribersCache = null
			},
		}
	}

	unbindAll(): void {
		for (const ev of this.boundEvents) unbindHostEvent(ev)
		this.boundEvents = []
		this.subscribers.clear()
		this.subscribersCache.clear()
		this.allSubscribers.clear()
		this.allSubscribersCache = null
	}
}
