/**
 * WireTransport bridges real Electron IPC in the main process.
 *
 * Responsibilities:
 * - Route webview → main RPC requests on `ipcMain.handle('__electron-deck:invoke')`
 *   and `'__electron-deck:probe'`. Apply `senderPolicy`, dispatch by kind to the
 *   host handler, and serialize the result into an `InvokeResponse` frame.
 * - Subscribe to the framework `EventBus` and push declared `HostEvent.publish(payload)`
 *   events to all trusted webContents via `webContents.send('__electron-deck:event', envelope)`.
 *
 * This class holds dependency references without importing 'electron' directly;
 * tests inject fakes through plain dependency injection.
 * Its lifecycle is single-use: after start → dispose, it cannot start again, preventing
 * listener leaks and duplicate handler registration. The host must construct a new instance to restart.
 *
 * @internal
 */

import { DeckRemoteError } from '../errors.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DeckChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeFailure,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
} from '../shared/protocol.js'
import type { Disposable, JsonValue, SenderPolicy } from '../types.js'
import type { EventBus } from './event-bus.js'

/**
 * Framework-reserved invoke failure codes all use the `DECK_` prefix to avoid
 * collisions with host-defined codes. Neither clients nor hosts should throw codes with this prefix.
 */
export const DECK_CODE = {
	UntrustedSender: 'DECK_UNTRUSTED_SENDER',
	UntrustedFrame: 'DECK_UNTRUSTED_FRAME',
	UnknownKind: 'DECK_UNKNOWN_KIND',
	BadRequest: 'DECK_BAD_REQUEST',
	/** The grant gate denied a privileged command for this sender. */
	Forbidden: 'DECK_FORBIDDEN',
} as const

/** Minimal RenderFrameHost identity used for main-frame discrimination. */
export interface FrameRef {
	readonly routingId: number
	readonly processId: number
}

/**
 * Per-invoke context threaded from {@link WireTransport.handleInvoke} into the
 * host invoke seam. Constructed ONLY after the wire's trust gate +
 * main-frame gate have both passed, so `senderId` is a real trusted webContents
 * id (never undefined). The grant gate (in `ControlBus.dispatch`) reads
 * this; it is a REQUIRED param so a missing call
 * site is a COMPILE error, not a silent security downgrade.
 */
export interface InvokeCtx {
	/** webContents id of the invoke sender (after the wire's trust + main-frame gates). */
	readonly senderId: number
	/** sender frame ref; main-frame already validated. Kept for future per-frame use; may be null. */
	readonly senderFrame: FrameRef | null
}

export interface MinimalIpcMain {
	handle(
		channel: string,
		handler: (
			// `mainFrame`/`senderFrame` are optional: real Electron events always
			// carry both (object or null after navigation), but frame-unaware unit
			// stubs model neither — the gate skips the frame check only for the
			// latter (see `isMainFrameSender`).
			event: { sender: { id: number, mainFrame?: FrameRef | null }, senderFrame?: FrameRef | null },
			...args: unknown[]
		) => unknown | Promise<unknown>,
	): void
	removeHandler(channel: string): void
}

export interface MinimalWebContents {
	readonly id: number
	isDestroyed(): boolean
	send(channel: string, payload: unknown): void
}

export interface WireTransportDeps {
	readonly ipcMain: MinimalIpcMain
	readonly bus: EventBus
	readonly senderPolicy: SenderPolicy
	/** Return the current trusted webContents snapshot for event broadcasts; called anew on every publish. */
	readonly trustedWebContents: () => readonly MinimalWebContents[]
	/** Route host-kind calls; WireTransport catches handler errors and converts them to InvokeFailure.
	 *  `ctx` is required: its senderId has passed the trust and main-frame checks and is used for authorization. */
	readonly invokeHost: (name: string, args: readonly JsonValue[], ctx: InvokeCtx) => Promise<JsonValue>
	/**
	 * Declared event names allowed in wire fanout. **Required; default-deny**:
	 * undeclared names never cross process boundaries, preventing accidental
	 * `bus.publish('foo')` calls inside the framework from leaking events to webviews.
	 * Return the current declared event names on each call; this snapshot is reread on every publish.
	 */
	readonly declaredEvents: () => readonly string[]
	/**
	 * OPTIONAL slot-token inbound: `__electron-deck:snapshot` apply path. When
	 * provided, `start()` registers the `Snapshot` handler (same trust + main-frame
	 * gate as invoke). On gate pass → `onSnapshot(senderId, rawSnapshot)`. The
	 * payload (the renderer's window-level placement table) is opaque here and
	 * authorized/validated downstream — the wire only enforces the trust boundary.
	 */
	readonly onSnapshot?: (senderId: number, rawSnapshot: unknown) => void
	/**
	 * OPTIONAL slot-token inbound: `__electron-deck:layout-subscribe` per-wc
	 * replay request. When provided, `start()` registers the `LayoutSubscribe`
	 * handler (same gate). On gate pass → `onLayoutSubscribe(senderId)`.
	 */
	readonly onLayoutSubscribe?: (senderId: number) => void
}

type LifecycleState = 'idle' | 'started' | 'disposed'

export class WireTransport {
	private readonly deps: WireTransportDeps
	private state: LifecycleState = 'idle'
	private busSubscription: Disposable | null = null
	/** Whether the optional Snapshot / LayoutSubscribe handlers were registered
	 *  (either eagerly at start() via deps, or lazily via armSlotChannels) — so
	 *  dispose() only removes channels it actually registered. */
	private snapshotRegistered = false
	private layoutSubscribeRegistered = false
	/** Effective slot callbacks. Populated from deps at start() (eager path, used
	 *  by the wire unit tests) OR by {@link armSlotChannels} (lazy path, used by
	 *  deck-app so an app with no anchored views registers only Invoke + Probe). */
	private onSnapshotCb: ((senderId: number, rawSnapshot: unknown) => void) | null = null
	private onLayoutSubscribeCb: ((senderId: number) => void) | null = null

	constructor(deps: WireTransportDeps) {
		this.deps = deps
	}

	start(): void {
		if (this.state === 'started') {
			throw new Error('WireTransport already started')
		}
		if (this.state === 'disposed') {
			throw new Error('WireTransport already disposed (single-use lifecycle); construct a new instance to restart')
		}
		this.state = 'started'

		// Roll back every registered handler and subscription if any registration step throws.
		// Otherwise, resetting the state leaves a partial registration that dispose() skips
		// because state !== 'started', and the ipcMain handlers are never removed.
		const cleanups: Array<() => void> = []
		try {
			this.deps.ipcMain.handle(DeckChannel.Probe, () => this.handleProbe())
			cleanups.push(() => this.tryRemoveHandler(DeckChannel.Probe))

			this.deps.ipcMain.handle(DeckChannel.Invoke, (event, ...args) =>
				this.handleInvoke(event?.sender?.id, event?.senderFrame, event?.sender?.mainFrame, args[0]))
			cleanups.push(() => this.tryRemoveHandler(DeckChannel.Invoke))

			// Eager path: deps carry the slot callbacks → register at start() (the
			// WireTransport unit tests drive this). deck-app instead leaves the deps
			// undefined and arms lazily via armSlotChannels() on the first anchored
			// placeIn, so a slot-less app registers only Invoke + Probe.
			if (this.deps.onSnapshot) {
				this.onSnapshotCb = this.deps.onSnapshot
				this.registerSnapshotHandler()
				cleanups.push(() => this.unregisterSnapshotHandler())
			}
			if (this.deps.onLayoutSubscribe) {
				this.onLayoutSubscribeCb = this.deps.onLayoutSubscribe
				this.registerLayoutSubscribeHandler()
				cleanups.push(() => this.unregisterLayoutSubscribeHandler())
			}

			this.busSubscription = this.deps.bus.subscribeAll((name, payload) => {
				this.fanoutEvent(name, payload)
			})
			cleanups.push(() => {
				if (this.busSubscription) {
					this.busSubscription.dispose()
					this.busSubscription = null
				}
			})
		}
		catch (err) {
			// Undo successful steps in reverse order. Log and swallow cleanup errors
			// so they do not replace the original error being rethrown.
			for (let i = cleanups.length - 1; i >= 0; i -= 1) {
				try {
					cleanups[i]?.()
				}
				catch (cleanupErr) {
					console.error('[electron-deck] start() rollback cleanup failed:', cleanupErr)
				}
			}
			this.state = 'idle'
			throw err
		}
	}

	private tryRemoveHandler(channel: string): void {
		try {
			this.deps.ipcMain.removeHandler(channel)
		}
		catch (e) {
			console.error(`[electron-deck] removeHandler(${channel}) failed:`, e)
		}
	}

	private registerSnapshotHandler(): void {
		if (this.snapshotRegistered) return
		this.deps.ipcMain.handle(DeckChannel.Snapshot, (event, ...args) =>
			this.handleSnapshot(event?.sender?.id, event?.senderFrame, event?.sender?.mainFrame, args[0]))
		this.snapshotRegistered = true
	}

	private unregisterSnapshotHandler(): void {
		if (!this.snapshotRegistered) return
		this.snapshotRegistered = false
		this.tryRemoveHandler(DeckChannel.Snapshot)
	}

	private registerLayoutSubscribeHandler(): void {
		if (this.layoutSubscribeRegistered) return
		this.deps.ipcMain.handle(DeckChannel.LayoutSubscribe, event =>
			this.handleLayoutSubscribe(event?.sender?.id, event?.senderFrame, event?.sender?.mainFrame))
		this.layoutSubscribeRegistered = true
	}

	private unregisterLayoutSubscribeHandler(): void {
		if (!this.layoutSubscribeRegistered) return
		this.layoutSubscribeRegistered = false
		this.tryRemoveHandler(DeckChannel.LayoutSubscribe)
	}

	/**
	 * Lazily register the slot-token inbound channels (`Place` + `LayoutSubscribe`)
	 * on an already-started wire, wiring them to the given callbacks. Idempotent:
	 * subsequent calls just refresh the callbacks (the handlers are registered
	 * once). deck-app calls this on the FIRST anchored `placeIn`, so an app with
	 * no anchored views never registers these channels (keeping the wire's
	 * handler footprint at Invoke + Probe until a slot is actually minted).
	 */
	armSlotChannels(
		onSnapshot: (senderId: number, rawSnapshot: unknown) => void,
		onLayoutSubscribe: (senderId: number) => void,
	): void {
		this.onSnapshotCb = onSnapshot
		this.onLayoutSubscribeCb = onLayoutSubscribe
		if (this.state !== 'started') return
		this.registerSnapshotHandler()
		this.registerLayoutSubscribeHandler()
	}

	dispose(): void {
		if (this.state !== 'started') {
			// idle → mark disposed without touching ipcMain; disposed → idempotent no-op
			this.state = 'disposed'
			return
		}
		this.state = 'disposed'

		try {
			this.deps.ipcMain.removeHandler(DeckChannel.Invoke)
		}
		catch (e) {
			console.error('[electron-deck] removeHandler(invoke) failed:', e)
		}
		try {
			this.deps.ipcMain.removeHandler(DeckChannel.Probe)
		}
		catch (e) {
			console.error('[electron-deck] removeHandler(probe) failed:', e)
		}
		// Only remove the optional channels we actually registered, so a wire with
		// no onSnapshot/onLayoutSubscribe deps removes exactly Invoke + Probe.
		if (this.snapshotRegistered) {
			this.snapshotRegistered = false
			try {
				this.deps.ipcMain.removeHandler(DeckChannel.Snapshot)
			}
			catch (e) {
				console.error('[electron-deck] removeHandler(snapshot) failed:', e)
			}
		}
		if (this.layoutSubscribeRegistered) {
			this.layoutSubscribeRegistered = false
			try {
				this.deps.ipcMain.removeHandler(DeckChannel.LayoutSubscribe)
			}
			catch (e) {
				console.error('[electron-deck] removeHandler(layout-subscribe) failed:', e)
			}
		}

		if (this.busSubscription) {
			this.busSubscription.dispose()
			this.busSubscription = null
		}
	}

	private handleProbe(): ProbeResponse {
		return { ready: true, version: BRIDGE_PROTOCOL_VERSION }
	}

	/**
	 * Defense-in-depth main-frame check. A trusted webContents may embed a
	 * sub-frame of arbitrary origin; only its top frame should reach gated
	 * invoke, so a sub-frame can't spoof the trusted sender id.
	 *
	 * - NEITHER field modeled → frame-unaware stub → not a real frame boundary;
	 *   the sender-id gate is the boundary → allow (back-compat with the legacy
	 *   `{ sender: { id } }` stubs).
	 * - either null (incl. a real event whose `senderFrame` resolved to null after
	 *   navigate-after-send / frame destruction, or a partial/malformed event) →
	 *   fail-closed → reject.
	 * - main frame (routingId + processId match) → allow; else (sub frame) reject.
	 */
	private isMainFrameSender(senderFrame: FrameRef | null | undefined, main: FrameRef | null | undefined): boolean {
		if (senderFrame === undefined && main === undefined) return true
		if (senderFrame == null || main == null) return false
		return senderFrame.routingId === main.routingId && senderFrame.processId === main.processId
	}

	private async handleInvoke(
		senderId: number | undefined,
		senderFrame: FrameRef | null | undefined,
		mainFrame: FrameRef | null | undefined,
		rawReq: unknown,
	): Promise<InvokeResponse> {
		const validation = validateRequest(rawReq)
		if (!validation.ok) {
			return failure(validation.name, validation.message, DECK_CODE.BadRequest)
		}
		const req = validation.req

		if (typeof senderId !== 'number' || !this.deps.senderPolicy.isTrusted(senderId)) {
			return failure(req.name, `untrusted sender (id=${String(senderId)})`, DECK_CODE.UntrustedSender)
		}

		// Frame-level gate sits ON TOP of the sender-id gate (not a replacement).
		if (!this.isMainFrameSender(senderFrame, mainFrame)) {
			return failure(req.name, `untrusted frame (sender id=${String(senderId)})`, DECK_CODE.UntrustedFrame)
		}

		// Both gates passed → senderId is a real trusted number. Build the ctx once
		// and thread it into the seam (the grant gate reads ctx.senderId).
		const ctx: InvokeCtx = { senderId, senderFrame: senderFrame ?? null }

		try {
			if (req.kind === 'host') {
				const result = await this.deps.invokeHost(req.name, req.args, ctx)
				return { ok: true, result }
			}
			return failure(req.name, `unknown invoke kind: ${String(req.kind)}`, DECK_CODE.UnknownKind)
		}
		catch (err) {
			return serializeError(req.name, err)
		}
	}

	/**
	 * `__electron-deck:snapshot` inbound. Same gate as {@link handleInvoke} (trust +
	 * main-frame). On any gate failure (non-object payload, untrusted sender,
	 * sub-frame) → DROP silently. The payload's inner shape is opaque to the wire —
	 * authorized + validated downstream.
	 */
	private handleSnapshot(
		senderId: number | undefined,
		senderFrame: FrameRef | null | undefined,
		mainFrame: FrameRef | null | undefined,
		rawSnapshot: unknown,
	): void {
		if (rawSnapshot === null || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) return

		if (typeof senderId !== 'number' || !this.deps.senderPolicy.isTrusted(senderId)) return
		if (!this.isMainFrameSender(senderFrame, mainFrame)) return

		this.onSnapshotCb?.(senderId, rawSnapshot)
	}

	/**
	 * `__electron-deck:layout-subscribe` inbound. Same gate as {@link handleInvoke}.
	 * On gate pass → `onLayoutSubscribe(senderId)`; else DROP silently.
	 */
	private handleLayoutSubscribe(
		senderId: number | undefined,
		senderFrame: FrameRef | null | undefined,
		mainFrame: FrameRef | null | undefined,
	): void {
		if (typeof senderId !== 'number' || !this.deps.senderPolicy.isTrusted(senderId)) return
		if (!this.isMainFrameSender(senderFrame, mainFrame)) return

		this.onLayoutSubscribeCb?.(senderId)
	}

	private fanoutEvent(name: string, payload: JsonValue): void {
		if (this.state !== 'started') return
		// The declaredEvents allowlist is default-deny: forwarding an internal
		// bus.publish(name) across processes when config.events does not declare name
		// would leak an event to webviews. Drop it and warn.
		const declared = this.deps.declaredEvents()
		if (!declared.includes(name)) {
			console.warn(`[electron-deck] dropping undeclared event "${name}" from wire fanout`)
			return
		}
		const env: EventEnvelope = { name, payload }
		let targets: readonly MinimalWebContents[]
		try {
			targets = this.deps.trustedWebContents()
		}
		catch (e) {
			console.error('[electron-deck] trustedWebContents() threw:', e)
			return
		}
		for (const wc of targets) {
			if (wc.isDestroyed()) continue
			try {
				wc.send(DeckChannel.Event, env)
			}
			catch (e) {
				console.error(`[electron-deck] webContents.send("${DeckChannel.Event}") failed for wc#${wc.id}:`, e)
			}
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

type ValidationResult =
	| { ok: true, req: InvokeRequest }
	| { ok: false, name: string, message: string }

function validateRequest(raw: unknown): ValidationResult {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, name: 'unknown', message: 'invoke request must be a plain object' }
	}
	const r = raw as Record<string, unknown>
	const { kind, name, args } = r
	if (typeof kind !== 'string') {
		return {
			ok: false,
			name: typeof name === 'string' ? name : 'unknown',
			message: 'invoke request.kind must be a string',
		}
	}
	if (typeof name !== 'string') {
		return { ok: false, name: 'unknown', message: 'invoke request.name must be a string' }
	}
	if (!Array.isArray(args)) {
		return { ok: false, name, message: 'invoke request.args must be an array' }
	}
	// Do not reject a string kind other than host here; the handler returns UNKNOWN_KIND.
	return {
		ok: true,
		req: {
			kind: kind as InvokeRequest['kind'],
			name,
			args: args as readonly JsonValue[],
		},
	}
}

function failure(remoteName: string, message: string, code?: string): InvokeFailure {
	return { ok: false, error: { remoteName, message, code } }
}

function serializeError(invokeName: string, err: unknown): InvokeFailure {
	// Preserve remoteName and code when the host throws DeckRemoteError. A host
	// wrapping or rethrowing another remote call with this class must not overwrite its origin.
	if (err instanceof DeckRemoteError) {
		// Use `??`, not `||`: an explicit `new DeckRemoteError('', ...)` uses the
		// empty string to mean "unknown origin". Preserve it rather than substituting invokeName.
		return failure(err.remoteName ?? invokeName, err.message, err.code)
	}
	if (err instanceof Error) {
		const errAny = err as Error & { code?: unknown }
		const code = typeof errAny.code === 'string' ? errAny.code : undefined
		return failure(invokeName, err.message, code)
	}
	let message: string
	try {
		message = String(err)
	}
	catch {
		message = 'unknown error (failed to stringify)'
	}
	return failure(invokeName, message)
}
