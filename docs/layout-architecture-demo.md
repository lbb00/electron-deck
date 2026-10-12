# Layout architecture demo: windows and page layout with a minimal host

> This document illustrates high-level host API calls, showing layout without business details. The four underlying primitives are Scope / Layout-Placement / Compositor / ControlBus.
>
> - ViewHandle (per-view orchestration), slot-token, and the layout client connect these calls: `runtime.view({source,scope}).placeIn(win,{zone,anchor})` attaches a native view to a window; renderer `createDeckLayoutClient({bridge})` anchors make it follow the DOM slot, with slot-token and main-process anti-spoof checks. `placeIn` / `applyPlacement` return the handle for chaining; `moveTo` / `dispose` end the chain and return a `Promise`. A complete runnable example is in `examples/layout-demo/`; primitive contracts are in [`architecture.md`](./architecture.md) §4.
>
> ⚠️ The high-level surface (`runtime.windows` / `runtime.view` / `runtime.scopes`) is `@experimental`: implemented and wired, but currently used only by `examples/layout-demo`, with signatures not yet API-stable. Downstream hosts use `RuntimeBackend` + `ownsWindows:true` without this surface.

## Architecture in one sentence

A **window** consists of a lifetime **Scope**, a z-stack **Compositor**, and a control-layer renderer (React, with DOM columns). The main process uses **Compositor** to layer native `WebContentsView`s (simulator / debug panel / overlay) above DOM by zone; **Layout/Placement** DOM placeholder anchors align their positions. `ControlBus` + capability (`electron-deck/host`) are independent tools that the framework no longer wires automatically. Hosts wanting business React code to drive layout through them must assemble them in `backend.assemble`.

> Electron constraint: native views always composite above DOM and cannot interleave with its z-order. A dropdown above a native panel must itself be a **native view** in the highest zone.

## Main process: main.ts

```ts
import { app, ipcMain } from 'electron'
import { startElectronDeck } from 'electron-deck'

// Compositor z-layers: lower values below, higher values above
const Z = { PREVIEW: 0, PANEL: 10, OVERLAY: 100 }

const { ready } = startElectronDeck({
	app: {
		window: { width: 900, height: 520 },
		// Declarative main-window entry: framework automatically loads source after window creation
		source: { url: 'app://control-shell' },
	},
	backend: {
		// Framework-created main window uses host preload (exposeDeckLayoutBridge requires sandbox:false)
		mainWindowWebPreferences() {
			return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
		},

		async assemble(runtime) {
			// ── 1. Framework-created main window returned through Window facade (without ownsWindows)
			const main = runtime.windows.main // DeckWindow
			const mainWin = main.window // Native BrowserWindow

			let session = null
			// ── 2. Open project: window-rooted session lifetime ⊂ window lifetime
			ipcMain.on('open-project', () => {
				session = main.newSession() // Closing project only resets session; window stays alive

				// Preview panel: native view anchored to DOM #preview placeholder
				runtime
					.view({ source: previewSource(), scope: session })
					.placeIn(mainWin, { zone: Z.PREVIEW, anchor: '#preview' })

				// Right debug panel: another native view, at a higher z-layer
				runtime
					.view({ source: panelSource(), scope: session })
					.placeIn(mainWin, { zone: Z.PANEL, anchor: '#panel' })
			})

			// ── 3. Close returns to main instead of closing window (window lifetime > session lifetime)
			main.onClose(async () => {
				if (session) {
					await session.reset() // Gracefully release all project-page resources
					session = null
					return 'keep' // Keep window open
				}
				return 'close'
			})

			// ── 4. Overlay above native views (settings / dropdown obscured by a panel):
			// Native view in the highest zone, anchored to a DOM placeholder
			function showOverlay(src, anchor) {
				return runtime
					.view({ source: src, scope: session ?? main.newSession() })
					.placeIn(mainWin, { zone: Z.OVERLAY, anchor }) // Top of native z-stack
			} // Returns DeckViewHandle; .dispose() closes it

			// ── 5. Drag panel into an independent window (live migration; popout demo verifies no reload/state loss)
			function popout(view) {
				const win = runtime.windows.create({ source: { url: 'app://popout-shell' } })
				// moveTo moves placement (cross-window Compositor mount); rehome:true also moves lifetime.
				// Placement ≠ lifetime: default moves only display; lifetime remains with original session.
				view.moveTo(win.window, { zone: Z.PANEL, anchor: '#panel', rehome: true })
			}

			// ── 6. Control-layer privileged layout commands: runtime.layout command registration and
			// runtime.grants authorization convenience APIs have been removed. Hosts still needing
			// privileged commands authorized per window/session must wire electron-deck/host's
			// createControlBus() + createCapabilityRegistry() themselves, outside the runtime facade.
			// A simpler alternative is ordinary hostServices RPC for commands such as collapse-preview.
		},
	},
})

ready.catch((err) => {
	console.error(err)
	app.quit()
})
```

## Control-layer renderer: control-shell.tsx, the underlying DOM layer

```tsx
import { createDeckLayoutClient } from 'electron-deck/client'

// Preload exposeDeckLayoutBridge() has attached the ready-to-use bridge to window
const deck = createDeckLayoutClient({ bridge: window.__electronDeckLayoutBridge })
// deck.dispose() stops anchors on unmount

function ProjectShell() {
	return (
		<div className="split">
			{/* DOM panel: React owns CSS layout */}
			<Toolbar onOpenProject={(id) => window.__demoControl.openProject(id)} />

			{/* Native-view placeholders: React renders divs and reports bounds; main process layers native views above them.
          createDeckLayoutClient's view-anchor measures slots with ResizeObserver.
          Drag splitter → slot size changes → publish Placement automatically → native view follows.
          No explicit resize code. */}
			<div id="preview" className="flex-1" />
			<div id="splitter" />
			<div id="panel" style={{ width: 360 }} />
		</div>
	)
}
```

## Primitives behind each call

| Demo call                                                                                                    | Underlying primitive                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.windows.main` / `runtime.windows.create` / `main.window` / `main.controlWc` / `main.onClose`        | Window + **Scope** + **Compositor** + close decision state machine. ControlBus is independent; hosts assemble it in backend.assemble if needed.                                                                                     |
| `main.newSession()` / `session.reset()` / `session.dispose()`                                                | **Scope** nested lifetimes (window-rooted DeckSession) + completion fence                                                                                                                                                           |
| `runtime.view({source,scope}).placeIn(win,{zone,anchor})` / `.applyPlacement()` / `.moveTo()` / `.dispose()` | **ViewHandle** thin orchestration over per-window Compositor: Compositor + Layout/Placement + Scope. Slot-token: anchored placeIn pushes a slot-grant; renderer anchors make native views follow DOM slots.                         |
| Privileged commands + capability checks (removed convenience surface; host assembles them)                   | **capability** authorization (`electron-deck/host` createCapabilityRegistry, bound to control-wc senderId with wc.id-reuse safety) + grant gate; host uses createControlBus().command and checks the grant gate (no grant → reject) |
| `createDeckLayoutClient({bridge})` in renderer                                                               | Subscribe to slot-grant → createViewAnchor(followScroll/followGeometry/treatZeroAreaAsHidden) → publish place with slotToken and main-process anti-spoof checks. Preload exposeDeckLayoutBridge provides the ready-to-use bridge.   |

## What the calls express

1. **Window = Scope (lifetime) + Compositor (z-stack) + control renderer (DOM layout)**.
2. **No page-layout code in the main process**: `view.placeIn(win, {zone, anchor})` attaches the native view. React owns DOM columns; placeholder anchors align native views automatically during splitter dragging.
3. **One call for each of three needs**: close back to main = `session.reset()`; dropdown above a panel = `placeIn(OVERLAY zone)`; popout = `view.moveTo(win, {rehome:true})`.
4. **Business-driven layout uses the layout client plus a host-defined privileged command channel**. The renderer installs createDeckLayoutClient so native views follow DOM. The runtime.layout command-registration / runtime.grants grant-issuance convenience surface has been removed from runtime. Hosts needing that authorization model wire `electron-deck/host` createControlBus + createCapabilityRegistry themselves; the main process still contains no layout logic.
