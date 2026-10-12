---
'electron-deck': minor
---

Upgrade the dependency to view-anchor `1.0.0-beta.2`.

v1 merges the previous two anchor types into `createViewAnchor` and renames `guardDisplayNone` to `treatZeroAreaAsHidden`. beta.2 no longer listens for splitter interactions on the consumer's behalf. `createDeckLayoutClient` calls the anchor's `pulse()` on splitter press and during dragging so native views continue following position-only changes.

**Breaking change**: this affects only consumers injecting `createAnchor`. The factory receives `treatZeroAreaAsHidden` instead of `guardDisplayNone`, and its returned anchor must implement `pulse()` as well as `dispose()`. Consumers using the default factory need no changes.

Update the size baselines for `./client` and `./client/browser` to 3266 bytes (gzip). Upgrading to beta.2 alone measured 3014 bytes; adding per-move splitter `pulse()` following measured 3266 bytes. The size gate still limits subsequent growth to 5% over the baseline.
