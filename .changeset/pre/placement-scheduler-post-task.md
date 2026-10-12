---
'electron-deck': minor
---

Publish placements by default in the next macrotask after the current render step rather than the next animation frame

When the renderer measures a changed slot rectangle, it must send the new placement to the main process. Previously this waited for the next `requestAnimationFrame`, adding about 17 ms on average in measurements. A MessageChannel macrotask now takes about 1 ms. This delay was the main contributor to native-view lag during splitter or panel dragging.

Only the default changes. Consumers injecting `schedulePublish` into `createDeckLayoutClient` or `createPlacementPublisher` continue to use their injected scheduler.

**Observable timing change**: a placement can now reach the main process within the same frame rather than necessarily in the next one. Recheck code depending on an implicit ordering relative to the next paint, such as changing the DOM and reading main-process state in the same tick. The measurement frequency is unchanged: view-anchor's own rAF follow loop and ResizeObserver still drive measurements, and the browser throttles both when the window is hidden.
