# view-anchor following contract: geometry for split, nested, and tab layouts

> This page defines the observation and timing contracts that let the forward `view-anchor` APIs (`createViewAnchor` / `useViewAnchor`) make a native `WebContentsView` **follow any DOM slot**: which movement signals must be observed, how to observe them, who owns visibility, and how to guarantee first-frame and termination behavior. Implementation belongs in `view-anchor/src/{view-anchor,react,types}.ts`.
>
> Why this document lives in `electron-deck/`: host-shell split/nested/tab requirements explain **why reliable following is necessary** (`electron-deck` is the host); **how to provide it** is the view-anchor primitive's contract. The boundary between the packages is the injected `publish`, so the host defines the contract and the primitive implements it.

---

## 0. Default observation coverage: opt-ins disabled

Without any opt-in options, a forward anchor observes **two types of signal**:

```ts
observer = new ResizeObserver(emit) // ① target's own border-box changes
observer.observe(target)
window.addEventListener('resize', emit) // ② whole-window resize
```

This **equates** changes to the target's screen rectangle with changes to its own size. That holds for a **single fixed panel**: preview / notes placeholders are direct flex:1 children whose rectangles change only with container size. Once a slot lives inside split / nested / tab layouts, the equivalence breaks. **Ancestor** actions can change the rectangle without changing the target's size; ResizeObserver cannot detect that, and the native view immediately loses alignment.

`useViewAnchor`'s `deps` (`react.ts`) lets callers force re-publication for state that moves the rectangle but is invisible to DOM observation. However, callers must **enumerate every such state in advance**. A slot usable in arbitrary split/tab layouts cannot know its outer splitters, nesting depth, or scroll containers. Following arbitrary slots therefore cannot depend on `deps`: **the anchor itself** must complete its observation coverage. The §2 opt-ins `followScroll` / `followGeometry` / `treatZeroAreaAsHidden` provide that coverage.

---

## 1. Six movement signals and their remedies

| #   | Signal                                                                      | Why default observation misses it                                                                                                                           | Remedy                                                                |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **Ancestor movement**, such as dragging an outer splitter in a nested split | Inner slot size is unchanged, so RO does not fire; window is not resized                                                                                    | RAF geometry sentinel (§2.D)                                          |
| 2   | **Scroll**, with the slot inside a scrollable container                     | Scroll changes position, not size; RO is blind, and scroll does not become a window resize                                                                  | Ancestor scroll capture listeners + RAF sentinel (§2.C/D)             |
| 3   | **CSS transform**, such as an ancestor transform / translate animation      | Screen position and getBoundingClientRect left/top change, but **no DOM event** reports it                                                                  | RAF geometry sentinel (§2.D): the central reason RAF is indispensable |
| 4   | **`display:none`**, such as a hidden tab                                    | Slot leaves the render tree and getBoundingClientRect returns all zeros, interpreted as visible at (0,0), 0×0; native view remains or flashes in the corner | IntersectionObserver visibility geometry + geometry guard (§3)        |
| 5   | **Slot not mounted / first-frame layout unstable**                          | Synchronous measurement returns a zero or stale rectangle; native view flashes at (0,0)                                                                     | First-frame guard (§4)                                                |
| 6   | **Destruction without a terminal hidden publication**                       | Core dispose deliberately stops observing without further publications; host receives no hidden on slot unmount, so native view stays at its last rectangle | Terminal hidden publication (§5)                                      |

Overall strategy: **preserve the forward anchor's synchronous-publication core** (§7 explains why publication cannot all move to RAF). **Add observers around it**, with each callback still using the existing synchronous `emit()`.

---

## 2. Extending observation coverage with a minimal, stable combination

### Design criterion

“Follow any slot” means remeasure and publish for every signal that changes `target.getBoundingClientRect()` on screen. Classify signals by whether a DOM event or Observer can report them precisely:

- **Precisely reported by events (A/B/C)**: own-size changes, whole-window resize, and ancestor scroll. Use **event-driven** observation with no idle work.
- **Reported by no event (D)**: ancestor transforms, displacement caused by ancestor reflow when siblings change, and any movement that leaves the target's own size unchanged. These require **polling** and comparing `getBoundingClientRect`.

The minimum combination is **event-driven A+B+C for most changes, plus a D RAF sentinel activated only when movement is plausible**. **RAF is not permanent**: interaction-window gating (§2.D + §6) gives zero idle cost.

### A. ResizeObserver: enabled by default

`observer.observe(target)` observes the target's own border-box changes. See §2.E for coordination with `display:none` (RO does not fire; IO does).

### B. Window resize: enabled by default

Observe whole-window size changes.

### C. Ancestor scroll listeners: followScroll, event-driven

When a slot scrolls inside a container, `scroll` **does not bubble** to window. `view-anchor` listens both during window capture and on scrollable ancestors. Window handles ordinary page scroll; ancestor listeners cover Shadow DOM or detached subtrees whose events do not reach window. Include `overflow: hidden` ancestors because code can change their scroll position. Do not process the same event again at an ancestor if it reaches window.

- **Passive**: listeners only read and never call preventDefault, so browser scrolling is not blocked.
- **Callback**: scroll is continuous and frequent. With `followGeometry` disabled, synchronously `emit()` once. With it enabled, scroll **opens the §2.D RAF sentinel window**: measure once per frame during scrolling and stop when scrolling stops. Share D's “measure during interaction, never while idle” mechanism instead of adding a second throttler.

### D. RAF geometry sentinel: followGeometry, non-permanent

The sentinel is the only fallback for transforms and ancestor movement. Transforms and ancestor reflow that pushes the target **have no events**. dockview's `OverlayRenderContainer` handles them with permanent RAF remeasurement of getBoundingClientRect. This anchor instead uses a bounded observation window (§7 explains the cost):

```
RAF sentinel = windowed requestAnimationFrame polling:
  - Each frame: measure(target), compare with lastPublished, emit only on change
    (reuse existing synchronous emit + dedup).
  - Start: interaction-window gating in §6.
  - Stop: N consecutive frames (suggest N=2–3, tune on real hardware) have rectangles
    equal field by field to the previous frame → stationary → cancelAnimationFrame.
```

The sentinel lives **only while there is reason to believe geometry is moving**:

- Opening signals: ancestor scroll (§2.C), or callers explicitly declaring drag/animation periods with `pulse()` (§2.F). `view-anchor` no longer automatically listens for splitters.
- Automatic closing: consecutive stationary frames. If a drag pauses long enough to close the window, the caller must `pulse()` again on the next movement. Idle cost returns to zero after dragging.

> Why not measure every frame permanently, even with dedup? See §7. Permanent RAF wastes work when N anchors coexist and most are still. Windowing limits the work to the anchor actually being interacted with.

### E. IntersectionObserver: treatZeroAreaAsHidden, geometry only

See §3. IO answers whether the target has **geometrically visible, nonzero area** in the viewport or is `display:none`. It **does not** decide whether the caller wants it shown. The §3 table defines that boundary.

### F. Explicit animation hint: pulse()

CSS transitions/animations—tab slide-ins and panel expansion, for example—can move slots without scroll or splitter dragging. `pulse()` lets callers **open a temporary window**:

```ts
handle.pulse(durationMs?: number)   // imperative core: open RAF window; close after durationMs or once stationary
```

`deps` means “republish immediately once,” for one frame; `pulse` means “follow every frame for a period,” throughout an animation. Callers only need to know that an animation is beginning, without enumerating its rectangle positions. `pulse()` is a no-op when `followGeometry` is disabled.

### Observation combinations

| Signal                                   | Observer                                                     | Driver             | Permanent?                   |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------ | ---------------------------- |
| Target's own size                        | ResizeObserver                                               | Event              | Yes; no callbacks while idle |
| Whole-window resize                      | Window resize                                                | Event              | Yes; no callbacks while idle |
| Ancestor scroll                          | Window capture + scrollable ancestor scroll (`followScroll`) | Event → RAF window | Yes; no callbacks while idle |
| Ancestor transform / reflow displacement | **RAF geometry sentinel** (`followGeometry`)                 | Polling            | **No**; windowed             |
| display:none / outside viewport          | IntersectionObserver (`treatZeroAreaAsHidden`)               | Event              | Yes; no callbacks while idle |
| Animation movement                       | `pulse()` → RAF window                                       | Caller hint        | No; windowed                 |

---

## 3. Visibility sources: geometry and caller intent

`createViewAnchor`'s `{ visible:false }` option expresses **caller intent only**. The anchor does not infer hiddenness from geometry by itself: `measurePlacement` always returns `visible:true`, following “hiddenness is a caller decision.” That design is correct; IO **does not reverse it**.

| Dimension                                                                                    | Authority                     | Mechanism                                                       | Failure if confused                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Intent**: should the view appear on screen (inactive tab, manually collapsed panel)?       | **Caller**                    | `visible:false` and other visibility APIs                       | If IO takes over, scrolling out of view causes unsolicited detach, then reattach on return: flicker and cross-process churn |
| **Geometry**: is target in DOM, does it have a nonzero screen rectangle, is it display:none? | **Anchor (IO + measurement)** | IntersectionObserver + all-zero getBoundingClientRect detection | If callers handle it, forgetting intent on display:none leaves the view at its old position (signal #4)                     |

**Responsibility boundary**:

1. **Visibility intent always belongs to the caller**. On tab switch, the caller explicitly publishes `visible:false` for the inactive slot, or electron-deck's tab container does so for its member slots. The anchor **never** converts “scrolled outside viewport” to `visible:false` through IO; temporary invisibility is not intent to hide.
2. **IO adds one geometry fallback: prevent display:none remnants**. When target becomes display:none (IO reports `isIntersecting:false`, an all-zero `intersectionRect`, and an all-zero `boundingClientRect`), publish **`{ visible:false }`**, meaning detach without bounds, **not** zero-sized `visible:true`. Reasons:
   - `display:none` or a slot without any geometry box means **no geometry to anchor to**: an objective fact, not changed caller intent. The Placement discriminant (`types.ts`) requires two distinct states: `{ visible:true, bounds:0×0 }` for an existing element legitimately rendered at zero size, and `{ visible:false }` for no geometry box / hidden, **without bounds**. This eliminates “magic zero.” display:none belongs to the latter; **never** disguise it as visible 0×0, which would again conflate no box with a legitimate zero-size element.
   - Hosts interpret `{ visible:false }` as **detach but keep alive**: detach the native view while retaining WebContents. When display returns (IO reports intersection / measurement obtains a nonzero box), reattach immediately.
   - **This does not overwrite caller intent**. `visible:false` means **do not show this view**, reached by an **OR of two causes**: caller hide intent **or** anchor-observed absence of a geometry box (display:none / not mounted). IO reports the objective second cause and ORs it with caller intent without overwriting or flipping that intent bit. Either cause produces the same hidden final state. “No geometry to anchor to” is a fact, not an intent.

   > **Boundary with `{visible:true, bounds:0×0}`**: reserve the latter **only** for an element that is still in the render tree, has a geometry box, but legitimately has zero area (for example, content collapsing to zero height). display:none / not mounted / no geometry box always uses `{visible:false}`. Rule: **box with zero area → visible:true+0×0; no box → visible:false**.
   >
   > This discriminant is v1's sole visibility representation. Before 1.0, a Bounds-only channel used all-zero rectangles as detach for display:none, conflating legitimate 0×0 and no box. v1 combines both anchor forms into createViewAnchor; with treatZeroAreaAsHidden enabled, no geometry box always publishes `{ visible:false }`.

3. **Boundary in one sentence**: **whether to show is caller intent; whether and where a view can currently attach is anchor geometry**. The anchor never decides intent; the caller should never calculate geometry manually.

---

## 4. First-frame guard: avoid a native-view flash at (0,0)

Signal #5: before a slot enters DOM, or while initial layout is unstable, synchronous measurement returns a stale/zero rectangle and the native view flashes at (0,0). Contract:

**Before the first valid rectangle, never publish a rectangle that puts the native view in the wrong place.**

Rules for the initial `apply()` publication and first IO frame:

1. **Invalid rectangle**: `width===0 || height===0`, including all-zero unmounted/display:none rectangles and collapsed unstable layout.
2. **Invalid first frame publishes detach instead of a nonzero rectangle**:
   - Publish **`{ visible:false }`**, detach without bounds as in §3.2 (unmounted / all-zero means no geometry box). **Never** publish nonzero bounds or zero-sized `visible:true`.
3. **Use IO + RAF sentinel to wait for the first nonzero rectangle**. `isIntersecting` becoming true, or a sentinel frame measuring nonzero width/height, triggers normal `emit()`, publishing the first real rectangle. The native view **appears directly at the correct position**, without a (0,0) flash.
4. **Do not publish placeholder nonzero bounds at (0,0)**. (0,0) is a legitimate **position** for a slot truly at the top-left. Position==0 cannot determine invalidity; use only **size==0**, consistent with clampRect clamping width/height to zero but not x/y.

> Trade-off: publishing nothing until the first valid rectangle also avoids the flash, but leaves a host view in an undefined “created, never received placement” state. One `{ visible:false }` frame (detach-but-keep) establishes detached state from the start; recovery is simply attach. Therefore **publish visible:false detach**.

---

## 5. Terminal hidden: detach on disposal/unmount to prevent remnants

Signal #6: core `dispose()` deliberately stops observation and **never publishes again**. This works when callers publish `{ visible:false }` first. An arbitrary React slot may unmount before the caller can send detach. Contract:

**At anchor end-of-life (dispose) or slot unmount, exactly one terminal detach signal must reach the host and remove the native view, without relying on the caller remembering to send it first.**

Split implementation between core and adapter:

- **Core createViewAnchor.dispose()**: **do not** publish automatically. Preserve post-disposal silence: core cannot decide that removing this view is the caller's desired final state, because the host may be handing the same view to another anchor.
- **React useViewAnchor adapter**: on `ref → null` / unmount, first publish `{ visible:false }` with `update({ ...options, visible:false })`, then dispose. This is the arbitrary-slot contract:
  - `ref(null)` (element detach) must publish detach before disposal.
  - Component unmount cleanup (`elRef.current===null`) must publish detach.
  - **Direct imperative createViewAnchor use**, without the React adapter: callers must publish `{ visible:false }` **before** dispose. Mark this **FOOTGUN** in createViewAnchor JSDoc, in the same style as size-anchor's `<body>` guard, because core intentionally does not add this publication.

**Why core must not publish automatically**: dispose means **stop observing**, not **remove the view**. A native view may be moving from one anchor to another (slot reparenting, moveTo); automatic hidden publication would visibly interrupt that handoff. The extra publication belongs to **the layer that knows the host protocol**: React adapter on unmount, imperative caller otherwise. The contract requires delivery of terminal detach; adapter-specific implementation preserves core silence.

---

## 6. Performance and jitter: multiple anchors and bounded RAF cost

### Cost model

Assume N simultaneous anchors, one native view for each split leaf:

| Signal                  | Idle cost             | Interaction cost                                                         |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| ResizeObserver ×N       | 0 callbacks           | Only the anchor whose size actually changes fires                        |
| Window resize           | 0                     | All N remeasure during whole-window dragging; all need it                |
| Capture scroll          | 0                     | Only while scrolling; opens the corresponding anchor's RAF window        |
| **RAF sentinel**        | **0 (window closed)** | **Only moving anchors open windows**; normally one dragged anchor, not N |
| IntersectionObserver ×N | 0 callbacks           | Only visibility changes trigger callbacks                                |

**Core argument**: **windowed RAF** (§2.D), rather than permanent RAF, makes idle cost strictly zero and interaction cost proportional to moving anchors rather than N. dockview's permanent RAF is an acceptable simplification for one overlay container. Here N independent anchors would each read getBoundingClientRect every frame (N forced layout reads), **even if only one moves**. That requires windowing.

### Deduplication and coalescing

- **Equal-value deduplication** (`lastPublished` + `sameRect` / `samePlacement`): during continuous dragging, each distinct rectangle produces at most one IPC. Equal sentinel measurements are discarded **without IPC**. Dedup hits also provide the stationary signal for consecutive-frame window closing (§2.D).
- **Multiple signals within one frame**: scroll and sentinel share one once-per-frame RAF body; multiple scroll events still produce one measurement. `lastPublished` prevents duplicate publication between synchronous RO/resize emit and the RAF body.
- **No time-based throttling**: like size-anchor, RAF following the refresh rate already supplies the limiting cadence. Extra throttling would discard legitimate discrete movement.

### Jitter sources and prevention

- The only jitter source is **IO treating out-of-viewport geometry as hide intent**, excluded by §3: IO does not modify intent.
- Close the sentinel after **two consecutive stationary frames**, not one. Drag pauses may close it; the client calls pulse again on the next movement.

---

## 7. Why publication must not all move to RAF

The strong constraint in `view-anchor.test.ts` is that the forward anchor's **event-driven path “never schedules a requestAnimationFrame.”** Its sink is cross-process setBounds, already roughly one composition frame late. Another RAF frame causes visible drag trailing, especially exposed background while GROWING. Keep this invariant.

Reconcile it by distinguishing **publication timing for two trigger types**:

1. **Event-driven triggers** (RO / resize / scroll-induced signals reporting a known discrete change) **publish synchronously**, without RAF. Event-observable parts of signals #1/#2 take this path, adding no frame.
2. **Polling triggers** (RAF sentinel for eventless ancestor movement #1 / transform #3) **are inherently per-frame polling**. RAF is their **only** implementation mechanism. This does not delay a synchronous publication; it actively measures once per frame when there is no event. Inside RAF, the sentinel **publishes synchronously as soon as it measures a change**, within that same frame, without another-frame deferral. It adds no publication-delay trailing; only **discovery** can be up to one frame late, inherent in polling without an event.

Thus “no RAF” means **event-driven paths must not defer publication through RAF**, not that the package can never contain requestAnimationFrame. Sentinel RAF is a **polling mechanism**, not a **publication delay**.

> **If an event reports it, publish synchronously. If no event reports it (transform/ancestor movement), poll each frame and publish in that frame.** Neither adds a frame for coalescing, preserving the protection against delayed-publication trailing.

---

## 8. Nested split walkthrough

Scenario: **left | right split; right subdivided into top / bottom; native view in bottom-right leaf; drag the outer left|right splitter**.

```
┌───────────────┬─────────────────────────┐
│               │ top-right: no native view │
│   left leaf   ├─────────────────────────┤
│               │ bottom-right leaf        │
│               │   └─ [placeholder div]   │ ← anchor / native WCV
└───────────────┴─────────────────────────┘
        ▲ drag the outer left|right splitter to the right
```

Dragging the outer splitter to the right:

1. The left leaf narrows, the right half widens and **moves left**. The bottom-right placeholder's **width changes** → **ResizeObserver fires** (§2.A) → synchronous emit → new rectangle with changed width and left-shifted x → publish. ✅ The width dimension **has an event**, so publication is synchronous with no trailing.

Now consider **leftward movement without a width change**: an outer splitter inside the right half, or a fixed-width right half displaced as a whole. The placeholder's **width/height stay unchanged; only x changes** because its ancestor moves it:

2. ResizeObserver **does not fire**: size has not changed. This is signal #1.
3. Splitter pointerdown starts dragging; createDeckLayoutClient calls `pulse()` on active anchors, again on every pointermove. If a pause closed the sentinel, the next movement reopens it. Changing x publishes the new x. ✅ The native view follows the leftward movement.
4. Pointer release or cancellation removes temporary client listeners; consecutive stationary frames close the sentinel.

Add a **scroll variant**, with the bottom-right leaf scrollable and the placeholder moving with content:

5. Scroll does not bubble to window, but **window capture** receives it (§2.C), opens RAF, measures the new y each scrolling frame, and publishes. ✅ Following stops at rest when the window closes.

Add a **transform variant**, where outer split expansion uses CSS transform rather than changing flex size:

6. Transform changes screen position and getBoundingClientRect left/top, but **no event reports it**. Call `pulse()` at animation start (§2.F); RAF follows every frame, then closes when stationary after the animation. ✅

**Conclusion**: A (size), C (scroll), D (pure splitter/transform displacement), and F (animation) cover every movement source a native view encounters in this nested split. Each has a trigger; all return to zero cost at rest.

---

## 9. API overview

> All changes are **additive**, preserving existing signatures. With options disabled, behavior remains “own-size changes + whole-window resize.”

### createViewAnchor: imperative Placement core

Follow options (all default off) and pulse belong to ViewAnchorOptions / ViewAnchorHandle:

```ts
interface ViewAnchorOptions {
	// ...visible / publish...
	/** Follow ancestor scroll with window capture + scrollable ancestor listeners. Default false. */
	followScroll?: boolean
	/** Enable RAF geometry sentinel for transforms / ancestor movement. Default false.
	 *  Scroll / pulse() opens the window; stationary detection closes it. */
	followGeometry?: boolean
	/** display:none fallback: observe with IntersectionObserver and publish `{ visible:false }`
	 *  for no geometry box (detach-but-keep, no bounds); remeasure on return. Default false. */
	treatZeroAreaAsHidden?: boolean
	/** Do not republish a Placement equal to the last accepted one. Default true. */
	dedupe?: boolean
	/** Abort stops the anchor. Read once at creation; update() does not accept this field. */
	signal?: AbortSignal
}

interface ViewAnchorHandle {
	/** Replace all options, not shallow-merge. Omitted options reset to defaults:
	 *  all three follow switches false, dedupe true. */
	update(opts: Omit<ViewAnchorOptions, 'signal'>): void
	dispose(): void
	/** Open one RAF sentinel window to follow an animation; close after durationMs or at rest.
	 *  No-op when followGeometry is false. */
	pulse(durationMs?: number): void
}
```

### useViewAnchor: React adapter

```ts
interface UseViewAnchorOptions extends ViewAnchorOptions {
	deps?: ReadonlyArray<unknown> // non-DOM dependency changes → force one republication
}
```

- The adapter handles terminal detach (§5): ref→null / unmount publishes `{ visible:false }` before disposal.
- Apart from deps, options are the full ViewAnchorOptions set. Follow options and pulse are also available to the hook.

### electron-deck host integration: outside view-anchor

- Each split leaf placeholder div uses a Placement anchor with `followScroll` / `followGeometry` / `treatZeroAreaAsHidden` enabled.
- `createDeckLayoutClient` recognizes splitter pointerdown during capture. Besides `[role="separator"]` in the event path, it checks whether a pointer originating inside this component's `[data-deck-split]` lies within a `[data-deck-resize-handle]` rectangle. `react-resizable-panels` may begin a drag from a hit area even when the event target is the neighboring panel. This avoids treating an element covering the split from outside as a separator, and also works for ShadowRoot in the event path. Only the separator element's rectangle is currently covered; any library hit margin outside that rectangle still needs separate verification. Call pulse on active anchors and again on every pointermove while pressed. Remove temporary listeners on release, cancellation, lost capture with buttons released, or window blur; continue following if capture transfers while buttons remain pressed. If release happens outside the window, the next button-free movement or a new press clears stale drag state. The anchor itself does not recognize splitters.
- Tab containers publish `visible:false` intent for inactive members and `visible:true` for active members.

---

## 10. Contract summary: guarantees and limits

**Signals guaranteed to be followed**:

1. Target's own size changes (RO, synchronous publication).
2. Whole-window resize (synchronous publication).
3. Ancestor scroll (`followScroll`, window capture + scrollable ancestor listeners, per-frame following while the window is open).
4. Pure displacement from ancestor transform/reflow (`followGeometry` RAF sentinel, per-frame following while open).
5. Animation movement (`pulse()` opens the window).
6. display:none hiding (`treatZeroAreaAsHidden` IO) → `{ visible:false }` (detach-but-keep, no geometry box); remeasure on return and reattach immediately.
7. First-frame unmounted/unstable layout → no stale nonzero rectangle; publish hidden detach and await the first valid rectangle (§4).
8. Disposal/unmount → terminal detach must arrive (§5, added by the layer knowing sink semantics).

**Limits and deliberate exclusions**:

- **No decisions about caller visibility intent**: outside viewport ≠ hide intent, and never causes anchor detach (§3).
- **No cross-process presentation-latency guarantee**: publish when a change is discovered; IPC and main-process composition timing are outside this package's control.
- **No permanent RAF**: strictly zero polling cost at rest (§2.D / §6).
- **No time-based throttling**: dedup + refresh-rate RAF already supplies the limiting cadence.
- **No automatic publication after core disposal**: the terminal detach form depends on sink semantics and belongs to adapters/callers (§5).
- **No decide / convergence policy / tab container**: host integration belongs in electron-deck.
