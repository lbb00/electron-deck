---
'electron-deck': minor
---

Reduce the public `@experimental` surface by removing declarative assembly and convenience APIs with no downstream consumers

These fields and types were marked `@experimental` but had no real downstream consumers. Keeping them added compatibility paths to consider for every new contract. Remove them in favor of the imperative APIs already in use.

Removed:

- `DeckConfig.toolbar` / `ToolbarContribution` / `runtime.toolbarView`: the entire toolbar assembly subsystem.
- `DeckConfig.windows` / `WindowContribution`: declarative window configuration.
- `DeckConfig.menu` / `MenuContribution` / `MenuBuildContext`: types that never had an implementation.
- `DeckConfig.lifecycle` / `LifecycleContribution` (including `beforeClose`).
- `DeckConfig.setup`.
- `runtime.grants`, `runtime.layout.command`, and `Grant.targetScope`. The general capability infrastructure in `capability.ts` under `electron-deck/host` is unchanged; `deck-app.ts` no longer provides these convenience wrappers or the privileged command route.
- `runtime.windows.get()`. The return type of `runtime.windows.all()` is narrowed to `DeckWindow[]`.
- The `role` in `window-created` is narrowed from `'main' | 'toolbar' | 'host'` to `'main' | 'host'` as a consequence of removing the toolbar subsystem. Comparisons with `'toolbar'` become invalid, and exhaustive switches must remove that case.

Replacements:

- `backend.assemble(runtime)` replaces `setup`: an assembly hook called once after runtime readiness, with the same return and throw semantics.
- `runtime.windows.create()` (called imperatively from `assemble`) replaces declarative `windows` configuration. It remains the only path for creating child windows.
- `backend.onShutdown` replaces `lifecycle.beforeClose`, but their timing is not equivalent. `lifecycle.beforeClose` had a default 10-second timeout; `backend.onShutdown` has no timeout and the framework awaits it indefinitely. Hosts needing a timeout should implement it in their own `onShutdown`, for example with `Promise.race`.

Two contract changes tighten behavior rather than remove it:

- `ViewCreateOptions.keepAlive` with `{ policy: 'lru', max }` now requires `group: string`. LRU eviction groups must be explicit instead of inferred.
- For a view placed with a nonempty `anchor` through `placeIn` or `moveTo` (page-driven, with renderer-controlled positioning), host calls to the public `handle.applyPlacement()` now throw. Views without an anchor are unaffected and can still use `applyPlacement`.

Also change the window parameter of `DeckViewHandle.placeIn` and `moveTo` to `BrowserWindow | DeckWindow`, accepting either directly.

**Breaking changes**: TypeScript reports the removed properties and methods rather than silently ignoring them. Consumers using `toolbar`, declarative `windows`, `menu`, `lifecycle`, `setup`, `grants`, `layout.command`, `targetScope`, or `windows.get()` must migrate using the replacements above. Consumers using `keepAlive` must add `group`. Hosts calling `applyPlacement` on page-driven views must remove those calls because the renderer already drives their positions.
