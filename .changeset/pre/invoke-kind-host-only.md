---
'electron-deck': minor
---

Remove the `simulator` concept: the wire supports only `host` calls, and `DeckConfig.simulatorApis` is removed

`InvokeKind` previously accepted `'host' | 'simulator'`. `WireTransportDeps` required an `invokeSimulator` callback, and `WireTransport.handleInvoke` routed `kind: 'simulator'` requests to it. The root entry's `DeckConfig.simulatorApis` configured this path: hosts registered handlers that the framework exposed as global APIs in the renderer.

`simulator` was a downstream host's business concept for running a second API set over the same wire. electron-deck itself neither produced nor consumed this kind; it merely included it in the public protocol. That extra branch forced hosts to organize a second API set in one prescribed shape, with no place for a third. Hosts can already dispatch through `invokeHost` using their own naming convention.

`InvokeKind` is now `'host'`. Remove `invokeSimulator` from `WireTransportDeps` and remove its dispatch branch. Also remove `DeckConfig.simulatorApis` and `SimulatorApiHandler`: this `@experimental` field was used only by examples and experimental scripts, and backend assembly never read it.

**Breaking changes**, all on the public export surface:

- `WireTransportDeps`, exported by `electron-deck/host`, no longer has `invokeSimulator`. TypeScript's excess-property checks reject callers still passing it rather than silently ignoring it.
- `InvokeRequest.kind`, exported by `electron-deck/preload`, is narrowed to `'host'`. Requests using `kind: 'simulator'` no longer type-check.
- The root entry no longer exports `SimulatorApiHandler`, and `DeckConfig` no longer accepts `simulatorApis`. Configurations still passing it fail excess-property checks.
- The root entry's `Runtime.call` no longer has `simulator(name, ...args)`. Replace `runtime.call.simulator()` with `runtime.call.host()`.

At runtime, stray `kind: 'simulator'` requests reach the existing `UnknownKind` branch and return a structured `InvokeFailure` rather than throwing or crashing.

Downstream hosts keeping these APIs must update both ends:

- Move handlers from `simulatorApis` to `hostServices`. Both use the same invoke channel and sender admission checks (trusted webContents and main frame, checked before kind dispatch), so this does not change permissions or impose extra naming restrictions. The `layout.` prefix was previously reserved for privileged commands and rejected by `hostServices`. This release removes that entire privileged route (`runtime.layout.command` and its ControlBus wiring; see the separate Changeset), so the reservation is also removed. `hostServices` now accepts all names, including those starting with `layout.`, as ordinary host services with no access to a privileged path.
- Change `kind: 'simulator'` to `kind: 'host'` at call sites. Dispatch multiple API sets by name prefix within `invokeHost`.
