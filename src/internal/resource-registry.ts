import type { Disposable, MaybePromise, ResourceRegistry } from '../types.js'

/**
 * I3: LIFO disposable registry.
 *
 * Contract:
 * - `add(d)` accepts a `Disposable` or a cleanup function taking no arguments. It returns
 *   a wrapper `Disposable` whose dispose calls the underlying cleanup and removes the entry
 *   from the registry, preventing a second call by disposeAll.
 * - `disposeAll()` calls dispose in **reverse registration order** (LIFO). A failure does not
 *   stop later cleanups; after all have run, it throws `AggregateError` if any failed.
 *   Subsequent calls resolve without doing anything.
 * - After disposeAll has run, `add()` immediately disposes new resources to prevent leaks.
 *
 * @deprecated Use `DisposableRegistry` in `src/main/disposable.ts` for the foundational
 *   disposal primitive (foundation.md §11, decision ①). The connection layer rejects add
 *   after disposal and resets by creating a new instance. This implementation instead
 *   immediately disposes resources added after disposal. Only the legacy `deck-app.ts`
 *   path still uses it; do not use it in new code. It is slated for removal.
 * @internal
 */
interface Entry {
	readonly id: number
	readonly dispose: () => MaybePromise<void>
}

export class ResourceRegistryImpl implements ResourceRegistry {
	private entries: Entry[] = []
	private nextId = 1
	private allDisposed = false

	add(d: Disposable | (() => MaybePromise<void>)): Disposable {
		const underlying: () => MaybePromise<void>
			= typeof d === 'function' ? d : () => d.dispose()

		if (this.allDisposed) {
			// add() after disposeAll() → dispose immediately without registering the resource, preventing leaks.
			void runQuietly(underlying)
			return { dispose: () => {} }
		}

		const id = this.nextId++
		const entry: Entry = { id, dispose: underlying }
		this.entries.push(entry)
		let disposedThis = false
		return {
			dispose: async () => {
				if (disposedThis) return
				disposedThis = true
				const idx = this.entries.findIndex(e => e.id === id)
				if (idx !== -1) this.entries.splice(idx, 1)
				await underlying()
			},
		}
	}

	async disposeAll(): Promise<void> {
		if (this.allDisposed) return
		this.allDisposed = true
		const toDispose = this.entries.slice().reverse()
		this.entries = []
		const errors: unknown[] = []
		for (const entry of toDispose) {
			try {
				await entry.dispose()
			}
			catch (e) {
				errors.push(e)
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`ResourceRegistry.disposeAll: ${errors.length} dispose(s) failed`,
			)
		}
	}
}

function runQuietly(fn: () => MaybePromise<void>): MaybePromise<void> {
	try {
		const r = fn()
		if (r && typeof (r as Promise<void>).then === 'function') {
			return (r as Promise<void>).catch(() => {})
		}
		return undefined
	}
	catch {
		return undefined
	}
}
