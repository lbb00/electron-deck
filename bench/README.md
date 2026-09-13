# bench/

Micro-benchmarks for the main-process per-frame path — not part of the build,
the test suite, or any CI gate. Run by hand when checking whether a change to
`src/layout/` moved the hot path.

## What it measures

`main-frame-path.mjs` drives the loop that runs once per renderer-reported
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
DIST=/tmp/electron-deck-baseline/dist/layout node --expose-gc bench/main-frame-path.mjs
```

Run both builds a few times each before drawing conclusions — a single run
is noisy (JIT warmup variance, other processes on the machine, thermal
throttling). Treat differences smaller than the run-to-run spread on a single
build as noise, not a real regression or improvement.
