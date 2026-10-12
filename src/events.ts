import { EventNotBoundError } from './errors.js'
import type { Disposable, HostEvent, JsonValue } from './types.js'

/**
 * Module-private internals. Publishers and listener sets live in a WeakMap rather than
 * class fields, so code holding a HostEvent cannot reach them through `as any` or the prototype chain.
 *
 * Limitation: two separately loaded copies of `electron-deck` in one process have separate WeakMaps.
 * This is a packaging issue, not an API-design issue; the framework expects a monorepo and peer dependency to keep one instance.
 */
interface EventInternals {
	publisher: ((payload: JsonValue) => void) | null
	listeners: Set<(payload: JsonValue) => void>
}

const internals: WeakMap<HostEvent<JsonValue>, EventInternals> = new WeakMap()

class HostEventImpl<P extends JsonValue> implements HostEvent<P> {
	readonly name: string

	constructor(name: string) {
		this.name = name
		internals.set(this as HostEvent<JsonValue>, {
			publisher: null,
			listeners: new Set(),
		})
	}

	publish(payload: P): void {
		const it = internals.get(this as HostEvent<JsonValue>)
		if (!it || it.publisher === null) throw new EventNotBoundError(this.name)
		it.publisher(payload as JsonValue)
		for (const l of it.listeners) {
			try {
				l(payload as JsonValue)
			}
			catch (e) {
				console.error(`[electron-deck] HostEvent "${this.name}" listener threw:`, e)
			}
		}
	}

	on(listener: (payload: P) => void): Disposable {
		const it = internals.get(this as HostEvent<JsonValue>)
		if (!it) {
			throw new TypeError(
				`HostEvent "${this.name}" has no internals — was it produced by defineEvent()?`,
			)
		}
		it.listeners.add(listener as (payload: JsonValue) => void)
		return {
			dispose: () => {
				it.listeners.delete(listener as (payload: JsonValue) => void)
			},
		}
	}
}

/** @experimental No production consumer yet — see the note on {@link HostEvent}. */
export function defineEvent<P extends JsonValue>(name: string): HostEvent<P> {
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError('defineEvent(name): name must be a non-empty string')
	}
	return new HostEventImpl<P>(name)
}

/**
 * Validates that `ev` came from `defineEvent()` by WeakMap identity rather than
 * `instanceof`, which also works across vm.Context instances sharing one module.
 *
 * @internal
 */
export function isHostEvent(ev: unknown): ev is HostEvent<JsonValue> {
	if (ev === null || typeof ev !== 'object') return false
	return internals.has(ev as HostEvent<JsonValue>)
}

/** @internal Called by the framework during Bind; a repeated bind on one instance replaces the previous publisher. */
export function bindHostEvent<P extends JsonValue>(
	event: HostEvent<P>,
	publisher: (payload: P) => void,
): void {
	const it = internals.get(event as HostEvent<JsonValue>)
	if (!it) {
		throw new TypeError(
			'bindHostEvent: argument is not a HostEvent produced by defineEvent()',
		)
	}
	it.publisher = publisher as (payload: JsonValue) => void
}

/** @internal Called by the framework during Cleanup. */
export function unbindHostEvent<P extends JsonValue>(event: HostEvent<P>): void {
	const it = internals.get(event as HostEvent<JsonValue>)
	if (it) {
		it.publisher = null
		it.listeners.clear()
	}
}
