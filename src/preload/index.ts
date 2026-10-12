import { contextBridge, ipcRenderer } from 'electron'
import {
	BRIDGE_PROTOCOL_VERSION,
	DEFAULT_BRIDGE_GLOBAL,
	DEFAULT_LAYOUT_BRIDGE_GLOBAL,
	DeckChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	DeckBridge,
} from '../shared/protocol.js'
import type { LayoutBridge, SlotGrant } from '../client/layout-client.js'

export interface ExposeBridgeOptions {
	/** Global name exposed on window; defaults to `__electronDeckBridge`. */
	readonly globalName?: string
}

/**
 * Call from the host preload to expose the framework's typed RPC and event-push bridge
 * on the webview window:
 *
 * ```ts
 * import { contextBridge, ipcRenderer } from 'electron'
 * import { exposeDeckBridge } from 'electron-deck/preload'
 * exposeDeckBridge()
 * ```
 *
 * See the `DeckBridge` interface (`shared/protocol.ts`).
 *
 * `@experimental` No production consumer yet — pairs with `createDeckClient` /
 * `DeckConfig.hostServices` / `events`, which only `examples/` uses;
 * no host in this repo calls `exposeDeckBridge`. Contract may change until a
 * second real consumer adopts it.
 */
export function exposeDeckBridge(options?: ExposeBridgeOptions): void {
	if (typeof contextBridge?.exposeInMainWorld !== 'function' || typeof ipcRenderer?.invoke !== 'function') {
		throw new Error('exposeDeckBridge: must be called from a preload script (electron contextBridge / ipcRenderer unavailable)')
	}

	const globalName = options?.globalName ?? DEFAULT_BRIDGE_GLOBAL
	// Check globalThis first to provide a clearer error than contextBridge's own duplicate-exposure check.
	const g = globalThis as unknown as Record<string, unknown>
	if (g[globalName] !== undefined) {
		throw new Error(`Deck bridge already exposed at "${globalName}"`)
	}

	const bridge: DeckBridge = {
		version: BRIDGE_PROTOCOL_VERSION,
		probe(): Promise<ProbeResponse> {
			return ipcRenderer.invoke(DeckChannel.Probe) as Promise<ProbeResponse>
		},
		invoke(req: InvokeRequest): Promise<InvokeResponse> {
			return ipcRenderer.invoke(DeckChannel.Invoke, req) as Promise<InvokeResponse>
		},
		onEvent(listener: (env: EventEnvelope) => void): () => void {
			const wrapped = (_event: unknown, env: EventEnvelope): void => {
				listener(env)
			}
			ipcRenderer.on(DeckChannel.Event, wrapped)
			return () => {
				ipcRenderer.removeListener(DeckChannel.Event, wrapped)
			}
		},
	}

	contextBridge.exposeInMainWorld(globalName, bridge)
}

export interface ExposeLayoutBridgeOptions {
	/** Global name exposed on window; defaults to `__electronDeckLayoutBridge`. */
	readonly globalName?: string
}

/**
 * Call from the host preload to wrap the three slot-token LAYOUT channels
 * (`slot-grant` push / `snapshot` send / `layout-subscribe` invoke) in a `LayoutBridge`
 * object exposed on the webview window for the renderer:
 *
 * ```ts
 * import { exposeDeckLayoutBridge } from 'electron-deck/preload'
 * exposeDeckLayoutBridge()
 * // renderer:
 * createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
 * ```
 *
 * Always use channel names from the framework's `DeckChannel` instead of copying strings.
 * `onSlotGrant` returns a plain unsubscribe function, which can cross contextBridge,
 * rather than a Disposable object.
 */
export function exposeDeckLayoutBridge(options?: ExposeLayoutBridgeOptions): void {
	if (typeof contextBridge?.exposeInMainWorld !== 'function' || typeof ipcRenderer?.on !== 'function') {
		throw new Error('exposeDeckLayoutBridge: must be called from a preload script (electron contextBridge / ipcRenderer unavailable)')
	}

	const globalName = options?.globalName ?? DEFAULT_LAYOUT_BRIDGE_GLOBAL
	const g = globalThis as unknown as Record<string, unknown>
	if (g[globalName] !== undefined) {
		throw new Error(`Deck layout bridge already exposed at "${globalName}"`)
	}

	const bridge: LayoutBridge = {
		onSlotGrant(cb: (grant: SlotGrant) => void): () => void {
			const listener = (_event: unknown, grant: SlotGrant): void => {
				cb(grant)
			}
			ipcRenderer.on(DeckChannel.SlotGrant, listener)
			return () => {
				ipcRenderer.removeListener(DeckChannel.SlotGrant, listener)
			}
		},
		sendSnapshot(snapshot): void {
			void ipcRenderer.invoke(DeckChannel.Snapshot, snapshot).catch(() => {})
		},
		subscribe(): void {
			void ipcRenderer.invoke(DeckChannel.LayoutSubscribe).catch(() => {})
		},
	}

	contextBridge.exposeInMainWorld(globalName, bridge)
}

export type {
	EventEnvelope,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
	DeckBridge,
	LayoutBridge,
	SlotGrant,
}
export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_GLOBAL, DEFAULT_LAYOUT_BRIDGE_GLOBAL, DeckChannel }
