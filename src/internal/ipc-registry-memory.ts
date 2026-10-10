import type { BrowserWindow } from 'electron'
import type {
	Disposable,
	JsonValue,
	MaybePromise,
	TypedIpcRegistry,
} from '../types.js'

type AnyHandler = (...args: JsonValue[]) => MaybePromise<JsonValue>
type AnyListener = (payload: JsonValue) => void

/**
 * In-memory `TypedIpcRegistry` implementation. Phase 2 does not use real Electron
 * `ipcMain`; this fake provides `handle`, `on`, `send`, and `invoke` within the main process.
 *
 * - `handle` / `invoke` and `on` / `send` use **independent channel namespaces**:
 *   send only notifies on listeners; invoke only calls handle handlers. They do not
 *   interfere even when the channel names match.
 * - Phase 2 accepts audience / validator options without enforcing them. Enforcement
 *   is deferred to Phase 3, when the trusted sender set is connected.
 *
 * @internal
 */
export class InMemoryTypedIpcRegistry implements TypedIpcRegistry {
	private readonly handlers = new Map<string, AnyHandler>()
	private readonly listeners = new Map<string, Set<AnyListener>>()

	handle<A extends JsonValue[], R extends JsonValue>(
		channel: string,
		handler: (...args: A) => MaybePromise<R>,
		_options?: {
			validator?: (args: unknown[]) => A
		},
	): Disposable {
		if (this.handlers.has(channel)) {
			throw new Error(`channel already handled: "${channel}"`)
		}
		const cast = handler as unknown as AnyHandler
		this.handlers.set(channel, cast)
		return {
			dispose: () => {
				if (this.handlers.get(channel) === cast) this.handlers.delete(channel)
			},
		}
	}

	on<P extends JsonValue>(channel: string, listener: (payload: P) => void): Disposable {
		let set = this.listeners.get(channel)
		if (!set) {
			set = new Set()
			this.listeners.set(channel, set)
		}
		const cast = listener as unknown as AnyListener
		set.add(cast)
		const ref = set
		return {
			dispose: () => {
				ref.delete(cast)
				if (ref.size === 0 && this.listeners.get(channel) === ref) {
					this.listeners.delete(channel)
				}
			},
		}
	}

	send(
		_target: 'mainWindow' | BrowserWindow,
		channel: string,
		payload: JsonValue,
	): void {
		const set = this.listeners.get(channel)
		if (!set) return
		const snapshot = Array.from(set)
		for (const l of snapshot) {
			try {
				l(payload)
			}
			catch (e) {
				console.error(`[electron-deck] ipc on "${channel}" listener threw:`, e)
			}
		}
	}

	/** @internal main-internal helper used by Phase 2 setup tests / framework */
	async invoke<R extends JsonValue>(channel: string, ...args: JsonValue[]): Promise<R> {
		const handler = this.handlers.get(channel)
		if (!handler) throw new Error(`no handler for channel: "${channel}"`)
		const r = await handler(...args)
		return r as R
	}
}
