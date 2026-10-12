---
'electron-deck': minor
---

Fix native views getting stuck at their old position after a panel move

After dragging a panel to another position or window, its native view could remain at the rectangle measured before release. A stuck hidden placement could also leave a view visible when it should disappear. Resizing the window did not recover it; the slot rectangle had to change again, the page had to navigate, or the window had to close.

The main process recorded a placement as applied before sending it to the view. A view can reject that frame during a `moveTo` transfer, or native attachment can throw. In either case the frame never takes effect, but the recorded state already claims it did. Reconciliation is level-triggered: it produces operations only when desired and recorded state differ. Subsequent identical frames therefore produce no operations and never retry the rejected placement.

Record the placement only after delivery. For views that reject it or throw, restore the previous recorded value so the next identical frame can retry.

**Breaking changes to the public `electron-deck/layout` exports**:

- The sink type accepted by `applyReconciledPlacements` changes from `(p: Placement) => void` to `(p: Placement) => boolean`, indicating whether the frame was accepted. Throwing is equivalent to returning `false`.
- `applyReconciledPlacements` changes its return type from `void` to `Set<string>`, containing the view IDs rejected in this pass. Callers must use it to roll back their own `state.actual`; otherwise they can retain the same incorrect recorded state.
- `ViewHandle.applyPlacement`, exported by `electron-deck/main`, also returns `boolean`. Consumers implementing `ViewHandle`, such as test doubles or adapters, must add that return value. Consumers that only call it are unaffected.

The root entry's `DeckViewHandle.applyPlacement` signature is unchanged and still returns the handle for chaining.
