---
'electron-deck': minor
---

Rename four APIs, split `draggable` into two capabilities, and fix `OverlayPanel.reposition()` behavior that contradicted its contract

**Renames (old → new, all breaking, with no aliases)**:

- `electron-deck/layout`: `validateTree` → `collectTreeProblems`
- `electron-deck/layout`: `cleanSnapshot` → `authorizeSnapshot`
- `electron-deck/layout`: `dispatchOps` → `applyReconciledPlacements`
- `electron-deck/client`: `LayoutClientDeps.requestFrame` / `cancelFrame` → `schedulePublish` / `cancelScheduledPublish` (the injection points of `createDeckLayoutClient`; the matching `PlacementPublisherDeps` fields are renamed too)

Consumers calling these symbols or injecting these dependency fields must replace them with the new names.

One exception matters: **injecting cancellation without scheduling no longer works**. Previously an injected `cancelFrame` was accepted on its own. Now `cancelScheduledPublish` is used only when `schedulePublish` is also injected; cancellation alone is ignored and replaced with a no-op. This is intentional: an ID belongs to the scheduler that issued it, and using another scheduler's cancellation function could cancel work belonging to a different publisher in the same process. Test doubles that override cancellation alone should inject scheduling as well when adopting the new names.

**Split `PanelCapabilities.draggable` into two fields**:

Previously `draggable` controlled both whether a panel could be dragged and whether other panels could dock into its group. These are now separate:

- `draggable?: boolean` controls whether the panel's tab can be dragged.
- `acceptsDrops?: boolean` (new) controls whether a group with this panel as its active tab accepts docking or splits from other panels.

**Fallback rule**: omitted `acceptsDrops` falls back to `draggable`, then to `true` (`acceptsDrops ?? draggable ?? true`). Existing registrations with `draggable: false` therefore remain unable to accept drops without changes. To keep a panel undraggable while allowing other panels to dock into it, explicitly set `acceptsDrops: true`.

**Fix the no-op condition in `OverlayPanel.reposition()`**: it previously checked only whether a native view existed. Calling it after `prepare()` or `hide()` could show the panel again, contradicting the documented no-op behavior for a panel that is not shown. It now checks `wantsVisible`, so `reposition()` after `prepare()` or `hide()` is a true no-op. Code relying on that bug to reveal a hidden panel must call `show()` explicitly.
