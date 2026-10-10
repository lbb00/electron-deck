/**
 * Deck framework wire protocol: channel names and frame shapes for main ↔ webview communication.
 * This is the source of truth imported by preload, client, and the main runtime.
 *
 * Declared `hostServices` and `events` share **two** channels, avoiding a proliferation
 * of channel names and making senderPolicy allowlisting straightforward:
 * - `__electron-deck:invoke` — webview → main RPC (ipcRenderer.invoke)
 * - `__electron-deck:event` — main → webview event push (webContents.send)
 * - `__electron-deck:probe` — webview → main liveness probe for the bridge-ready check
 *
 * Each frame uses a JSON-object envelope for extensibility and validation.
 *
 * @internal
 */

import type { JsonValue } from '../types.js'

/** Default global name used to expose the bridge via contextBridge.exposeInMainWorld. */
export const DEFAULT_BRIDGE_GLOBAL = '__electronDeckBridge'

/**
 * Default global name for the slot-token LAYOUT bridge. `exposeDeckLayoutBridge()` exposes
 * this name, and the renderer reads it via
 * `createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })`.
 * A shared constant keeps the preload helper and client names in sync.
 */
export const DEFAULT_LAYOUT_BRIDGE_GLOBAL = '__electronDeckLayoutBridge'

/** Bridge protocol semver; the client checks major-version compatibility during ready(). */
export const BRIDGE_PROTOCOL_VERSION = '1.0.0'

export const DeckChannel = {
	Invoke: '__electron-deck:invoke',
	Event: '__electron-deck:event',
	Probe: '__electron-deck:probe',
	Snapshot: '__electron-deck:snapshot',
	SlotGrant: '__electron-deck:slot-grant',
	LayoutSubscribe: '__electron-deck:layout-subscribe',
} as const

export type InvokeKind = 'host'

export interface InvokeRequest {
	readonly kind: InvokeKind
	readonly name: string
	readonly args: readonly JsonValue[]
}

export interface InvokeSuccess<R extends JsonValue = JsonValue> {
	readonly ok: true
	readonly result: R
}

export interface InvokeFailure {
	readonly ok: false
	readonly error: {
		readonly remoteName: string
		readonly message: string
		readonly code?: string
	}
}

export type InvokeResponse<R extends JsonValue = JsonValue> =
	| InvokeSuccess<R>
	| InvokeFailure

export interface EventEnvelope<P extends JsonValue = JsonValue> {
	readonly name: string
	readonly payload: P
}

export interface ProbeResponse {
	readonly ready: true
	readonly version: typeof BRIDGE_PROTOCOL_VERSION
}

/**
 * Shape of the bridge global exposed on the webview window. Preload injects it via
 * `contextBridge.exposeInMainWorld(globalName, bridge)`; the webview-side
 * `createDeckClient()` reads it through `globalThis[globalName]`.
 *
 * All methods must be contextBridge-friendly (plain values and serializable arguments).
 * Do not expose Map, Set, Date, Promise.race, or similar values through the bridge interface.
 */
export interface DeckBridge {
	readonly version: typeof BRIDGE_PROTOCOL_VERSION
	probe(): Promise<ProbeResponse>
	invoke(req: InvokeRequest): Promise<InvokeResponse>
	/** Subscribe to the event channel; return an unsubscribe function rather than a Disposable so it can cross contextBridge. */
	onEvent(listener: (env: EventEnvelope) => void): () => void
}
