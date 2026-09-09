# electron-deck

> Window and view orchestration for Electron: dockable panels whose native WebContentsViews follow the DOM, behind a single `electronDeck(config)` entry.

[![npm version](https://img.shields.io/npm/v/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![npm downloads](https://img.shields.io/npm/dm/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![License](https://img.shields.io/npm/l/electron-deck)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

A framework for building a host shell on Electron out of a small set of orthogonal primitives: multi-window management, native `WebContentsView` stacking and geometry following, overlays and popouts, and cross-process IPC. Hosts write an injected `RuntimeBackend`; the framework owns Electron setup, transport wiring, and trust boundaries.

## Features

- **One entry point** — `electronDeck(config)` takes a `RuntimeBackend` and takes over app assembly: `whenReady()` gating, transport wiring, trust boundary.
- **DOM-following native views** — WebContentsViews track DOM element geometry across the process boundary, built on top of [view-anchor](https://github.com/lbb00/view-anchor).
- **Dockable layouts** — a pure-TypeScript layout-as-data engine (`/layout`) and its React renderer `<DockView>` (`/dock-react`), both usable in plain-browser projects.
- **Browser-pure subpaths** — `/layout` and `/dock-react` (plus their transitive dependencies) never import `electron` or `node`; both boundaries are pinned by tests.
- **Subpath exports** — dedicated entry points for `main`, `preload`, `host`, `client`, `layout` and `dock-react`.
- **Graduated APIs** — a stable integration path via `electronDeck()`, plus an explicitly marked experimental declarative surface.

## Installation

```bash
pnpm add electron-deck
# or
npm install electron-deck
```

`electron` (`^43.2.0`) is an optional peer dependency — browser-only consumers of `/layout` and `/dock-react` don't need it. React ≥ 18 is required for `/dock-react`.

## Quick start

### Take over app assembly

Implement a `RuntimeBackend` (build windows and wire your own IPC in `assemble(runtime)`) and hand it to `electronDeck()`:

```ts
// main.ts
import { electronDeck } from 'electron-deck'
import { myBackend } from './my-backend.js'

electronDeck({ backend: myBackend }).catch((err) => {
  console.error(err)
  process.exit(1)
})
```

The framework waits for `app.whenReady()`, wires the transport, and enforces the trust boundary; you only assemble your domain (real context, main window content, views, IPC modules). Set `ownsWindows: true` when the backend owns the main window completely.

> **Don't `await electronDeck()` at the top level of your main module.** Electron only fires `whenReady` after the main module finishes evaluating, so a top-level await deadlocks. Use `.catch(...)`, or `startElectronDeck()` which gates on `whenReady()` internally.

### Window-internal docking only

`electron-deck/layout` is a pure-TypeScript layout-as-data engine; `electron-deck/dock-react` is its `<DockView>` React renderer. Both work in plain-browser web projects.

- The layout is a serializable tree of `SplitNode` / `TabGroupNode` nodes. `movePanel`, `splitPanel`, `closePanel`, `insertPanel`, `setActive`, `setSizes` and `setConstraint` are its mutations; `serializeLayout` / `parseLayout` / `validateTree` handle persistence; `createLayoutModel` is the observable single-writer model.
- Split children can carry a `SizeConstraint`: `fixedPx` pins a size, `minPx` sets a floor the user can still drag upward.
- Panel descriptors can carry `PanelCapabilities` (`draggable` / `dropPolicy` / `closable` / `hideTab`) that constrain dragging and closing; `computeReorderIndex` is the accompanying pure geometry function.

Runnable examples live in [examples/layout-demo](./examples/layout-demo) and [examples/dockable-demo](./examples/dockable-demo).

## Entry points

| What you need | Import from |
|---|---|
| `electronDeck` entry, `DeckConfig` / `RuntimeBackend` types | `electron-deck` |
| Main-process assembly utilities | `electron-deck/main` |
| Host-side control-bus / capability / trust primitives | `electron-deck/host` |
| Preload bridge `exposeDeckBridge()` | `electron-deck/preload` |
| Renderer client `createDeckClient<HS, EV>()` | `electron-deck/client` (`/client/browser` is an alias) |
| Layout-as-data engine + panel registry | `electron-deck/layout` |
| `<DockView>` + `computeReorderIndex` | `electron-deck/dock-react` |

## Experimental: declarative assembly

A higher-level declarative surface exists via `startElectronDeck()` with top-level config (`hostServices` / `events` / `toolbar`) and high-level runtime APIs (`runtime.windows` / `runtime.view` / `runtime.scopes` / `runtime.grants`):

```ts
import { startElectronDeck, defineEvent } from 'electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

startElectronDeck({
  app: { name: 'My Host' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
})
```

It currently has no production consumers outside this repo's examples — treat it as `@experimental`: signatures may change and it has not been validated under non-demo workloads. Its one concrete advantage over `electronDeck()` is internal `whenReady()` gating, so it can be called at the top level of a main module.

## Documentation

- [Architecture](./docs/architecture.md) — the four layout / multi-window primitives, the injected `RuntimeBackend`, trust boundaries, lifetimes
- [Connection layer](./docs/foundation.md) — `Connection`, resource ownership, `debugTap`
- [Cross-cutting contracts](./docs/contracts/) — capability gating and grants, unified lifetimes, view handles, view-anchor following

## Contributing

Issues and pull requests are welcome. Before submitting, run the checks locally: `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm build`.

## License

[MIT](./LICENSE) © lbb00
