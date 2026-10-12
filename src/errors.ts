/**
 * Thrown when `publish()` is called on an event created by `defineEvent()` that is not
 * explicitly listed in `DeckConfig.events`. This prevents implicit registration based on module load order.
 */
export class UndeclaredHostEventError extends Error {
	readonly eventName: string
	constructor(eventName: string) {
		super(
			`HostEvent "${eventName}" was not declared in DeckConfig.events. ` +
				`Add it to the events array so the framework knows to bind a transport for it.`,
		)
		this.name = 'UndeclaredHostEventError'
		this.eventName = eventName
	}
}

/**
 * Thrown when `HostEvent.publish()` is called during Init or Bind, before the transport is ready.
 * Calls from Setup onward are safe (fire-and-forget, with no replay).
 */
export class EventNotBoundError extends Error {
	readonly eventName: string
	constructor(eventName: string) {
		super(
			`HostEvent "${eventName}" publish() called before transport is bound. ` +
				`publish() is safe only from Setup phase onward.`,
		)
		this.name = 'EventNotBoundError'
		this.eventName = eventName
	}
}

/**
 * Thrown when a webview calls `client.ready()` without a framework bridge on `window`
 * because the host preload did not install `exposeDeckBridge()`.
 */
export class DeckClientNotReadyError extends Error {
	constructor(message = 'Deck framework bridge is missing on window — did the host preload call exposeDeckBridge()?') {
		super(message)
		this.name = 'DeckClientNotReadyError'
	}
}

/**
 * Wraps an error thrown by a remote hostServices handler during `client.invoke(name, ...)`.
 * Preserves the original message and includes remoteName and an optional code for webview-side classification.
 */
export class DeckRemoteError extends Error {
	readonly remoteName: string
	readonly code?: string
	constructor(remoteName: string, message: string, code?: string) {
		super(message)
		this.name = 'DeckRemoteError'
		this.remoteName = remoteName
		if (code !== undefined) this.code = code
	}
}
