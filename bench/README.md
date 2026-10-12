# bench/

Micro-benchmarks for the main-process per-frame path — not part of the build,
the test suite, or any CI gate. Run by hand when checking whether a change to
`src/layout/` moved the hot path.

## What it measures

`main-frame-path.js` drives the loop that runs once per renderer-reported
frame while a dock layout is live: `authorizeSnapshot -> reconcile -> applyReconciledPlacements`.
Two scenarios:

- **steady** — view bounds unchanged frame-to-frame. The common case; most
  frames should produce zero ops.
- **moving** — every view's bounds shift by 1px/frame. The worst case; every
  frame produces ops for every view.

For each scenario it reports average per-frame latency (µs/frame and
µs/view), ops emitted per frame, heap growth before a final forced GC, and
heap growth retained after that GC. The first heap number includes allocation
pressure and collector timing; use the retained number when comparing memory
retention. A third line reports a synthetic input-construction loop for context;
JIT optimization may differ from the end-to-end path, so it is not an IPC cost
floor.

## Running it

```sh
pnpm bench
```

Requires `--expose-gc` (the `bench` script already passes it); running the
file directly without that flag prints a usage message and exits 2.

## Comparing against another branch

The benchmark imports `dist/layout/index.js` from this repo by default. To
compare against another branch's build, check it out into a separate
worktree, build it there, and point `DIST` at its `dist/layout` directory:

```sh
git worktree add --detach /tmp/electron-deck-baseline origin/main
cd /tmp/electron-deck-baseline && pnpm install && pnpm run build
cd -
DIST=/tmp/electron-deck-baseline/dist/layout node --expose-gc bench/main-frame-path.js
```

Run both builds a few times each before drawing conclusions — a single run
is noisy (JIT warmup variance, other processes on the machine, thermal
throttling). Treat differences smaller than the run-to-run spread on a single
build as noise, not a real regression or improvement.

## Optional Electron process diagnostics

After building the package and the dockable demo bundle, run the real-input
check with process diagnostics enabled:

```sh
DECK_E2E_OUTPUT_DIR=/tmp/electron-deck-e2e \
DECK_DEMO_E2E_METRICS=1 node scripts/check-dockable-e2e.js
```

The run writes `e2e-metrics.json` beside the E2E log. Memory values are KiB.
CPU values are the average over the interval since the previous
`app.getAppMetrics()` call; the first sample establishes the baseline. This is
a short interaction sample, not a long-running endurance test, so one run
cannot prove or disprove a memory leak.

## Native view lifecycle probe

`electron-native-lifecycle.js` runs real Electron to check WebContentsView show → hide → show transitions, cross-window `moveTo()`, session `dispose()`, and `keepAlive` LRU eviction. At each checkpoint it records PID, creation time, working set (KiB), and average CPU usage between two `app.getAppMetrics()` samples. It also records how long destruction takes. Results are written outside the repository. Run it with:

```sh
DECK_NATIVE_LIFECYCLE_OUTPUT=/tmp/electron-deck-native-lifecycle.json \
  electron bench/electron-native-lifecycle.js
```

The report's `backgroundThrottling` section compares timer callback counts for hidden views in two separate host windows. Disabling background throttling for one view affects all WebContents in its window, so the two groups must use different windows. This short experiment shows only timer behavior on this machine during this run; it does not prove reduced CPU or memory usage. The script cleans up windows, views, and the framework runtime before exiting. On failure, check the `.trace.log` beside the result file. Run protocol assertions with `node --test bench/electron-native-lifecycle.test.js`.

Lifecycle rounds and the time spent hidden are configurable within limits: `DECK_NATIVE_LIFECYCLE_ROUNDS` allows at most 100 rounds, and `DECK_NATIVE_HIDDEN_DWELL_MS` ranges from 20 to 1000 ms (default: 40 ms). The report records the actual `hiddenDwellMs` used.

## Dockable demo tail latency

First run `pnpm run build` and `node examples/dockable-demo/bundle.js`, then execute:

```sh
DECK_DEMO_LAG=1 DECK_DEMO_SHOTS_DIR=/tmp/electron-deck-lag \
  electron examples/dockable-demo/main.js
```

`lag-report.json` records DOM frame intervals during real dragging, the delay between a DOM width change and the native view following it, and main-process event-loop delay. It reports P95/P99, sample counts, and whether the P99 estimate has fewer than 100 samples. Misses where the native view fails to catch up before the next DOM change are counted separately. A single run is diagnostic evidence only; it should not be treated as proof of an optimization gain or as a performance gate.
