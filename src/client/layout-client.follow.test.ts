// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeckLayoutClient } from './layout-client.js'
import type { SlotGrant } from './layout-client.js'

class Frames {
	private nextId = 0
	private pending = new Map<number, FrameRequestCallback>()

	request = (cb: FrameRequestCallback): number => {
		const id = ++this.nextId
		this.pending.set(id, cb)
		return id
	}
	cancel = (id: number): void => {
		this.pending.delete(id)
	}
	flush(): void {
		const callbacks = [...this.pending.values()]
		this.pending.clear()
		for (const callback of callbacks) callback(performance.now())
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.replaceChildren()
})

describe('createDeckLayoutClient — separator following', () => {
	it('publishes a position-only slot move after a drag pauses, and stops after dispose', () => {
		const frames = new Frames()
		const publishes = new Frames()
		vi.stubGlobal('requestAnimationFrame', frames.request)
		vi.stubGlobal('cancelAnimationFrame', frames.cancel)
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe(): void {}
				disconnect(): void {}
			},
		)

		const separator = document.createElement('div')
		separator.setAttribute('role', 'separator')
		const slot = document.createElement('div')
		slot.id = 'slot'
		document.body.append(separator, slot)
		let x = 10
		slot.getBoundingClientRect = () => ({
			x,
			y: 0,
			left: x,
			top: 0,
			right: x + 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		})

		let onGrant: ((grant: SlotGrant) => void) | undefined
		const snapshots: Array<{
			views: Array<{ placement: { visible: boolean; bounds?: { x: number } } }>
		}> = []
		const client = createDeckLayoutClient({
			bridge: {
				onSlotGrant: (cb) => {
					onGrant = cb
					return () => {
						onGrant = undefined
					}
				},
				subscribe: () => {},
				sendSnapshot: (snapshot) => snapshots.push(snapshot),
			},
			schedulePublish: (cb) => publishes.request(cb),
			cancelScheduledPublish: publishes.cancel,
		})

		try {
			onGrant!({ viewId: 'preview', slotId: '#slot', slotToken: 'token', generation: 1 })
			publishes.flush()
			expect(snapshots.at(-1)?.views[0]?.placement).toMatchObject({
				visible: true,
				bounds: { x: 10, width: 100 },
			})

			const pointer = (type: string) => {
				const event = new Event(type, { bubbles: true })
				Object.defineProperty(event, 'pointerId', { value: 1 })
				separator.dispatchEvent(event)
			}
			pointer('pointerdown')
			frames.flush()
			frames.flush() // steady follow window closes while the pointer is still down
			x = 40 // moving an ancestor changes the slot's position but not its border box
			pointer('pointermove')
			frames.flush()
			publishes.flush()
			expect(snapshots.at(-1)?.views[0]?.placement).toMatchObject({
				visible: true,
				bounds: { x: 40, width: 100 },
			})

			const count = snapshots.length
			client.dispose()
			publishes.flush()
			const disposedCount = snapshots.length
			expect(disposedCount).toBeGreaterThan(count)
			x = 70
			pointer('pointermove')
			frames.flush()
			publishes.flush()
			expect(snapshots).toHaveLength(disposedCount)
		} finally {
			client.dispose()
		}
	})

	it('does not register a pointer listener when bridge subscription fails', () => {
		const add = vi.spyOn(window, 'addEventListener')
		try {
			expect(() =>
				createDeckLayoutClient({
					bridge: {
						onSlotGrant: () => () => {},
						sendSnapshot: () => {},
						subscribe: () => {
							throw new Error('subscribe failed')
						},
					},
				}),
			).toThrow('subscribe failed')
			expect(add.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(0)
		} finally {
			add.mockRestore()
		}
	})

	it('pulses only live anchors for active separator pointers and clears the drag on cancel or blur', () => {
		const separator = document.createElement('div')
		separator.setAttribute('role', 'separator')
		const other = document.createElement('div')
		const slot = document.createElement('div')
		document.body.append(separator, other, slot)
		let onGrant: ((grant: SlotGrant) => void) | undefined
		const anchors: Array<{ dispose: ReturnType<typeof vi.fn>; pulse: ReturnType<typeof vi.fn> }> =
			[]
		const client = createDeckLayoutClient({
			bridge: {
				onSlotGrant: (cb) => {
					onGrant = cb
					return () => {}
				},
				subscribe: () => {},
				sendSnapshot: () => {},
			},
			resolveSlot: () => slot,
			createAnchor: () => {
				const anchor = { dispose: vi.fn(), pulse: vi.fn() }
				anchors.push(anchor)
				return anchor
			},
		})
		const pointer = (element: HTMLElement, type: string, pointerId = 1, buttons?: number) => {
			const event = new Event(type, { bubbles: true })
			Object.defineProperty(event, 'pointerId', { value: pointerId })
			if (buttons !== undefined) Object.defineProperty(event, 'buttons', { value: buttons })
			element.dispatchEvent(event)
		}
		try {
			onGrant!({ viewId: 'preview', slotId: '#slot', slotToken: 'first', generation: 1 })
			pointer(other, 'pointerdown')
			pointer(other, 'pointermove')
			expect(anchors[0]!.pulse).not.toHaveBeenCalled()

			pointer(separator, 'pointerdown')
			pointer(separator, 'pointermove')
			expect(anchors[0]!.pulse).toHaveBeenCalledTimes(2)
			onGrant!({ viewId: 'preview', slotId: '#slot', slotToken: 'next', generation: 1 })
			pointer(separator, 'pointermove')
			expect(anchors[0]!.pulse).toHaveBeenCalledTimes(2)
			expect(anchors[1]!.pulse).toHaveBeenCalledOnce()

			pointer(separator, 'pointercancel')
			const afterCancel = anchors[1]!.pulse.mock.calls.length
			pointer(separator, 'pointermove')
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterCancel)

			pointer(separator, 'pointerdown')
			window.dispatchEvent(new Event('blur'))
			const afterBlur = anchors[1]!.pulse.mock.calls.length
			pointer(separator, 'pointermove')
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterBlur)

			pointer(separator, 'pointerdown')
			pointer(separator, 'lostpointercapture', 1, 1)
			const afterTransferredCapture = anchors[1]!.pulse.mock.calls.length
			pointer(separator, 'pointermove', 1, 1)
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterTransferredCapture + 1)
			pointer(other, 'pointerdown', 1, 1)
			const afterReusedPointer = anchors[1]!.pulse.mock.calls.length
			pointer(other, 'pointermove', 1, 1)
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterReusedPointer)

			pointer(separator, 'pointerdown')
			pointer(separator, 'lostpointercapture', 1, 0)
			const afterLostCapture = anchors[1]!.pulse.mock.calls.length
			pointer(separator, 'pointermove')
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterLostCapture)

			pointer(separator, 'pointerdown')
			pointer(separator, 'pointermove', 1, 0)
			const afterReleasedMove = anchors[1]!.pulse.mock.calls.length
			pointer(separator, 'pointermove')
			expect(anchors[1]!.pulse).toHaveBeenCalledTimes(afterReleasedMove)
		} finally {
			client.dispose()
		}
	})

	it.each(['light', 'shadow'] as const)(
		'follows a separator hit inside %s DOM without following an unrelated overlay',
		(mode) => {
			const host = document.createElement('div')
			const overlay = document.createElement('div')
			document.body.append(host, overlay)
			const mount = mode === 'shadow' ? host.attachShadow({ mode: 'open' }) : host
			const split = document.createElement('div')
			split.setAttribute('data-deck-split', 'root')
			mount.append(split)
			const separator = document.createElement('div')
			separator.setAttribute('role', 'separator')
			separator.setAttribute('data-deck-resize-handle', '')
			separator.getBoundingClientRect = () =>
				({ left: 100, right: 110, top: 50, bottom: 250 }) as DOMRect
			const panel = document.createElement('div')
			const slot = document.createElement('div')
			split.append(separator, panel, slot)
			let onGrant: ((grant: SlotGrant) => void) | undefined
			const pulse = vi.fn()
			const client = createDeckLayoutClient({
				bridge: {
					onSlotGrant: (cb) => {
						onGrant = cb
						return () => {}
					},
					subscribe: () => {},
					sendSnapshot: () => {},
				},
				resolveSlot: () => slot,
				createAnchor: () => ({ dispose: vi.fn(), pulse }),
			})
			const pointer = (target: HTMLElement, type: string, x: number) => {
				const event = new Event(type, { bubbles: true, composed: true })
				Object.defineProperties(event, {
					pointerId: { value: 1 },
					buttons: { value: type === 'pointerup' ? 0 : 1 },
					clientX: { value: x },
					clientY: { value: 100 },
				})
				target.dispatchEvent(event)
			}
			try {
				onGrant!({ viewId: 'preview', slotId: '#slot', slotToken: 'first', generation: 1 })
				pointer(overlay, 'pointerdown', 105)
				pointer(overlay, 'pointermove', 105)
				pointer(panel, 'pointerdown', 120)
				pointer(panel, 'pointermove', 120)
				expect(pulse).not.toHaveBeenCalled()
				pointer(panel, 'pointerdown', 105)
				pointer(panel, 'pointermove', 105)
				expect(pulse).toHaveBeenCalledTimes(2)
				pointer(panel, 'pointerup', 105)
			} finally {
				client.dispose()
			}
		},
	)
})
