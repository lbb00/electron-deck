# bench/

Micro-benchmarks for the main-process per-frame path — not part of the build,
the test suite, or any CI gate. Run by hand when checking whether a change to
`src/layout/` moved the hot path.

## What it measures

`main-frame-path.js` drives the loop that runs once per renderer-reported
frame while a dock layout is live: `cleanSnapshot -> reconcile -> dispatchOps`.
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

`electron-native-lifecycle.js` 运行真实 Electron，检查 WebContentsView 的显示→隐藏→再显示、跨窗口 `moveTo()`、session `dispose()` 和 `keepAlive` 的 LRU 淘汰。它在每个检查点记录 `app.getAppMetrics()` 的 PID、创建时间、工作集（KiB）以及两次采样间的 CPU 平均值，并记录销毁耗时。结果写到仓库外；可这样运行：

```sh
DECK_NATIVE_LIFECYCLE_OUTPUT=/tmp/electron-deck-native-lifecycle.json \
  electron bench/electron-native-lifecycle.js
```

结果中的 `backgroundThrottling` 会在两个独立宿主窗口中，比较隐藏视图的计时器回调次数。一个视图关闭后台节流会影响同窗口的所有 WebContents，因此两组不能放在同一窗口。这个短实验只能说明本机这次运行的计时器行为，不能证明 CPU 或内存会改善。脚本结束前会清理窗口、视图和 framework runtime；若失败，检查结果文件旁的 `.trace.log`。协议断言可用 `node --test bench/electron-native-lifecycle.test.js` 运行。

生命周期轮数和隐藏停留时间可配置，但都有上限：`DECK_NATIVE_LIFECYCLE_ROUNDS` 最多 100 轮，`DECK_NATIVE_HIDDEN_DWELL_MS` 限制在 20–1000ms（默认 40ms）。报告会记录实际使用的 `hiddenDwellMs`。

## Dockable demo 尾延迟

先运行 `pnpm run build` 和 `node examples/dockable-demo/bundle.js`，再执行：

```sh
DECK_DEMO_LAG=1 DECK_DEMO_SHOTS_DIR=/tmp/electron-deck-lag \
  electron examples/dockable-demo/main.js
```

`lag-report.json` 记录真实拖动中的 DOM 帧间隔、DOM 宽度变化到 native view 跟随的延迟，以及主进程事件循环延迟。报告给出 P95/P99、样本数和 P99 是否少于 100 个样本；未能在下次 DOM 变化前追上的次数单独记录。单次运行只能作为诊断，不应当作优化收益或性能门槛。
