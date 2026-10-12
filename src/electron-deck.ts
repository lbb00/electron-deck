import { UndeclaredHostEventError } from './errors.js'
import { isHostEvent } from './events.js'
import type { MinimalElectron } from './internal/electron-types.js'
import type { MinimalIpcMain } from './internal/wire-transport.js'
import { DeckApp } from './internal/deck-app.js'
import type { DeckAppOptions } from './internal/deck-app.js'
import type { DeckConfig, DeckOptions, HostEvent, JsonValue, Runtime } from './types.js'

/**
 * `electronDeck(config, options?)` is the framework's only entry point (see README §3).
 *
 * - Invalid config → reject `TypeError`; do not advance the phase.
 * - Valid config → assemble the runtime, await `config.backend.assemble(runtime)`, then resolve.
 *   Without Electron, the framework retains the runtime after resolving. With an Electron app
 *   lifecycle, Electron's event loop keeps the process alive; the host main file need not await `electronDeck()`.
 *
 * A backend host calls `electronDeck({ backend })`: `backend` is a field of
 * {@link DeckConfig}, so it no longer needs an empty `{}` plus options.
 *
 * `options` is an injection point for tests and non-Electron environments (see {@link DeckOptions}).
 * Production code omits it, so the framework uses `await import('electron')` to obtain real `ipcMain` /
 * `BrowserWindow` / `WebContentsView`.
 */
export async function electronDeck(config: DeckConfig, options?: DeckOptions): Promise<void> {
	// Validate config BEFORE attempting electron resolution — invalid configs
	// must reject with TypeError regardless of environment. Electron load
	// failure is reported separately, only for
	// configs that would otherwise be acceptable.
	validateConfig(config)
	const resolved = await resolveAppOptions(options)
	if (config.backend) {
		;(resolved as Mutable<DeckAppOptions>).backend = config.backend
	}
	const app = new DeckApp(config, resolved)
	await app.start()
}

/**
 * Synchronous launch handle for `electronDeck`.
 *
 * `electronDeck(config)` is `async` and internally `await app.start()` →
 * `await app.whenReady()`. A host ESM main entry doing `await electronDeck(config)`
 * SUSPENDS module evaluation on the whenReady gate — but Electron's `ready` only
 * fires once module evaluation finishes, so the gate never resolves: HARD DEADLOCK.
 *
 * `startElectronDeck` returns a plain handle SYNCHRONOUSLY (NOT a thenable), so
 * module evaluation is never blocked by the call itself — the host gets the
 * handle back immediately and can keep running top-level code. `handle.ready`
 * still only resolves AFTER `app.whenReady()` (gating intact inside
 * `app.start()`), so a top-level `await handle.ready` deadlocks IDENTICALLY to
 * `await electronDeck(config)` — the fix is to never await `ready` at module top
 * level; defer it into an event handler or other post-ready code instead.
 * `handle.ready` resolves with the {@link Runtime}; `handle.dispose()` tears the
 * app down even if called before the in-flight start finished.
 *
 * Invalid config throws a `TypeError` synchronously (matching `electronDeck`'s
 * validate-first contract) — the error surfaces, never silently deadlocks.
 *
 * `@experimental` No production consumer yet — the only caller in this repo is
 * `examples/`; the host's real entry uses `electronDeck({ backend })` instead.
 * Contract may change until a second real consumer adopts it.
 */
export function startElectronDeck(
	config: DeckConfig,
	options?: DeckOptions,
): { ready: Promise<Runtime>; dispose(): Promise<void> } {
	// Validate config SYNCHRONOUSLY (before returning the handle) — invalid configs
	// surface a TypeError at the call, never a silent deadlock.
	validateConfig(config)

	let app: DeckApp | null = null
	const startPromise: Promise<DeckApp> = (async () => {
		const resolved = await resolveAppOptions(options)
		if (config.backend) {
			;(resolved as Mutable<DeckAppOptions>).backend = config.backend
		}
		app = new DeckApp(config, resolved)
		// `app.start()` internally `await app.whenReady()` THEN assembles — gating
		// stays intact: no window is constructed before whenReady resolves.
		await app.start()
		return app
	})()

	const ready = startPromise.then((a) => a.runtime)
	// Mark `ready` as handled so a fire-and-forget caller (who never reads `ready`,
	// e.g. `startElectronDeck(...)` then `dispose()`) does NOT trigger an
	// unhandledRejection if startup fails — which under strict Electron handling can
	// terminate the process. The caller's own `await handle.ready`
	// still observes the rejection; this extra no-op handler only suppresses the
	// "unhandled" classification, it does not swallow the error for the caller.
	void ready.catch(() => {})

	return {
		ready,
		async dispose(): Promise<void> {
			// dispose-before-ready safety: AWAIT the in-flight start (swallow its error
			// so a failed start still lets dispose clean up), THEN shut down — no race
			// with the rootScope teardown that start() set up. `shutdown()` is
			// idempotent (a second call is a no-op).
			const started = await startPromise.catch(() => null)
			if (started) {
				await started.shutdown()
			} else if (app) {
				// start threw post-construction → still tear down the partially-built app.
				await app.shutdown()
			}
		},
	}
}

/**
 * Resolves public `DeckOptions` into internal {@link DeckAppOptions}. A lazy
 * `import('electron')` supplies any dependency that was not explicitly injected.
 *
 * Decision matrix:
 * - `electron` + `ipcMain` are both explicitly injected → no lazy import (test/production override)
 * - Either is missing → `await import('electron')` and fill it from the imported module.
 *
 * Under Vitest, `await import('electron')` resolves to the package entry stub, which exports an
 * executable-path string; `ipcMain` and `BrowserWindow` are therefore undefined. Missing required
 * fields cause an explicit rejection that tells the caller to inject options.
 */
async function resolveAppOptions(opts?: DeckOptions): Promise<DeckAppOptions> {
	if (opts?.electron && opts?.ipcMain) {
		return buildAppOptions(opts.electron, opts.ipcMain, opts)
	}

	let imported: unknown
	try {
		imported = await import('electron')
	} catch (e) {
		throw new Error(
			'electronDeck(): unable to load electron — pass options.electron / options.ipcMain ' +
				'for non-Electron environments. Underlying: ' +
				String(e),
			{ cause: e },
		)
	}

	const m = imported as { ipcMain?: unknown; BrowserWindow?: unknown; WebContentsView?: unknown }
	const resolvedElectron = opts?.electron ?? asMinimalElectron(m)
	const resolvedIpcMain = opts?.ipcMain ?? (m.ipcMain as MinimalIpcMain | undefined)

	if (!resolvedIpcMain || !resolvedElectron.BrowserWindow || !resolvedElectron.WebContentsView) {
		throw new Error(
			'electronDeck(): loaded "electron" but it does not expose the main-process surface ' +
				'(ipcMain / BrowserWindow / WebContentsView). This typically means you are running ' +
				'outside an Electron main process (e.g. vitest under node). Pass options.electron ' +
				'and options.ipcMain to inject a fake.',
		)
	}

	return buildAppOptions(resolvedElectron, resolvedIpcMain, opts)
}

function asMinimalElectron(m: {
	BrowserWindow?: unknown
	WebContentsView?: unknown
}): MinimalElectron {
	// We do not validate shape here — `resolveAppOptions` does the BrowserWindow /
	// WebContentsView presence check before returning. Cast is intentional.
	return m as unknown as MinimalElectron
}

function buildAppOptions(
	electron: MinimalElectron,
	ipcMain: MinimalIpcMain,
	opts: DeckOptions | undefined,
): DeckAppOptions {
	const wireTransport: DeckAppOptions['wireTransport'] = { ipcMain }
	const out: DeckAppOptions = { electron, wireTransport }
	if (opts?.trustedWebContents) {
		;(
			out.wireTransport as Mutable<NonNullable<DeckAppOptions['wireTransport']>>
		).trustedWebContents = opts.trustedWebContents
	}
	if (opts?.senderPolicy) {
		;(out.wireTransport as Mutable<NonNullable<DeckAppOptions['wireTransport']>>).senderPolicy =
			opts.senderPolicy
	}
	return out
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Pure validation: it depends on neither Electron, IPC, nor framework state, and can be unit-tested
 * independently. Each check corresponds to a field constraint in doc §3.3.
 *
 * A config that passes validateConfig will not be rejected during framework Bind. This includes all
 * shape checks: HostEvent provenance, mutually exclusive sources, and map-versus-array forms.
 *
 * @internal exported for tests
 */
export function validateConfig(config: DeckConfig): void {
	if (config === null || typeof config !== 'object') {
		throw new TypeError('electronDeck(config): config must be an object')
	}

	validateBackendField(config.backend)

	if (config.hostServices !== undefined) {
		validateHandlerMap('hostServices', config.hostServices)
	}
	if (config.events !== undefined) {
		validateEventsField(config.events)
	}
}

function validateBackendField(backend: DeckConfig['backend']): void {
	if (backend === undefined) return
	const candidate = backend as { assemble?: unknown }
	if (
		candidate === null ||
		typeof candidate !== 'object' ||
		typeof candidate.assemble !== 'function'
	) {
		throw new TypeError(
			'config.backend must be a RuntimeBackend (an object with an assemble() function)',
		)
	}
}

function validateHandlerMap(fieldName: string, value: unknown): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${fieldName} must be an object of handlers`)
	}
	for (const [name, handler] of Object.entries(value as Record<string, unknown>)) {
		if (typeof handler !== 'function') {
			throw new TypeError(`${fieldName}["${name}"] must be a function`)
		}
	}
}

function validateEventsField(events: unknown): void {
	if (!Array.isArray(events)) {
		throw new TypeError('events must be an array of HostEvent (from defineEvent())')
	}
	assertAllHostEvents(events)
	assertUniqueEventNames(events as readonly HostEvent<JsonValue>[])
}

/** Reject duck-typed event shapes; accept only HostEvents produced by `defineEvent()` to avoid bind-time failures. */
function assertAllHostEvents(events: readonly unknown[]): void {
	for (const ev of events) {
		if (!isHostEvent(ev)) {
			throw new TypeError(
				'events: every entry must be a HostEvent produced by defineEvent() — ' +
					'duck-typed shapes are rejected to avoid bind-time failures',
			)
		}
	}
}

function assertUniqueEventNames(events: readonly HostEvent<JsonValue>[]): void {
	const names = new Set<string>()
	for (const ev of events) {
		if (names.has(ev.name)) {
			throw new Error(`events: duplicate HostEvent name "${ev.name}"`)
		}
		names.add(ev.name)
	}
}

/**
 * Publish-time guard: prevents publishing a HostEvent not explicitly listed in `config.events`,
 * avoiding implicit registration based on module load order.
 *
 * @internal exported for tests
 */
export function assertEventDeclared(declared: ReadonlySet<string>, eventName: string): void {
	if (!declared.has(eventName)) {
		throw new UndeclaredHostEventError(eventName)
	}
}
