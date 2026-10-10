# Dock layout epoch and view-anchor

`useDockLayoutEpoch()` tells Dock panels that the model has committed a new layout. Use it when a DOM slot moves without changing size, so `ResizeObserver` does not notify `view-anchor`.

## What advances the epoch

Whenever `LayoutModel.apply()` successfully returns a tree with a different reference, the model increments its revision and notifies subscribers. `DockView` receives that notification and uses the revision as the epoch. Typical operations include changing split weights or orientation, moving or reordering panels, switching the active tab, adding or closing panels, and recording collapse or restore operations in the layout model.

Changes to CSS, external React state, window size, or scroll position do not advance the epoch. Browser events and the corresponding `view-anchor` options handle those signals. An `apply()` call that returns the original tree, throws, or resolves to a no-op does not advance it either. React may batch multiple model commits so consumers see only the final epoch; do not use it as a log of individual changes.

The epoch starts at `0` and updates through subscription notifications for descendants of `<DockView>`. Revisions committed before `DockView` subscribes are not replayed into the epoch. It updates on the next notification, so it signals that this React tree has received a commit rather than mirroring the model revision at all times.

After React commits the new tree, consumers can read that commit's DOM in `useLayoutEffect`. `SplitView` may still synchronize the final programmatic panel sizes in its own effect and subsequent `requestAnimationFrame` callbacks. The epoch therefore does not guarantee that all split geometry has settled. It also does not wait for CSS transitions or animations: it signals a React layout commit, not the end of an animation.

## Integrating view-anchor 1.0.0

`view-anchor` 1.0.0 provides `remeasure()`. For ordinary Dock layout changes in React, update the anchor through `deps: [epoch]`:

```tsx
import { useViewAnchor } from 'view-anchor/react'
import type { Placement } from 'view-anchor'
import { useDockLayoutEpoch } from 'electron-deck/dock-react'

type Props = { visible: boolean; publish: (placement: Placement) => void }

function NativeSlot({ visible, publish }: Props) {
	const epoch = useDockLayoutEpoch()
	const ref = useViewAnchor({ visible, publish, deps: [epoch] })
	return <div ref={ref} className="native-slot" />
}
```

If the consumer manages `createViewAnchor` directly, call `handle.remeasure()` from its layout-committed callback. The consumer's layout code defines this callback; it is not a new electron-deck API:

```ts
const handle = createViewAnchor(slot, { visible: true, publish })
onConsumerLayoutCommitted(() => handle.remeasure())
```

This measures once, preserves the current options, and does not start frame-by-frame following. Do not substitute `update()`: omitted options reset to their defaults.

For CSS transitions that require the native view to follow each frame, enable `followGeometry: true` and call `pulse()` when the animation starts:

```ts
const handle = createViewAnchor(slot, { visible: true, publish, followGeometry: true })
startConsumerDockTransition()
handle.pulse()
```

`pulse()` only works when `followGeometry` is enabled. It stops early after two consecutive frames with an unchanged rectangle. Its duration is an upper bound, not a guarantee that following lasts that long; an animation that moves slowly during its first frames may stop being followed early. Do not use fixed delays to guess commit or animation timing. For splitter drags, the electron-deck client recognizes the active separator and its hit region, then calls existing anchors' `pulse()` on pointer down and each `pointermove`. Moving again after a pause restarts following.

Consumers can define their own `useDockViewAnchor` wrapper. The `electron-deck/dock-react` entry does not import or depend on `view-anchor`, although electron-deck's client entry already depends on it.

## Positioning before readiness

The previously reported lost position came from consumer code that guarded `reposition()` on readiness. Calling `reposition()` on a shown overlay before it is ready stores the latest bounds, which are used once it becomes ready. Do not suppress these calls with a readiness guard. For a panel created by `prepare()` but never shown, or a panel hidden with `hide()`, `reposition()` remains a no-op by contract; the consumer decides when to call `show()`.
