# Formal Verification with TLA+

`electron-deck` provides host-shell orchestration for Electron: native WebContentsViews that follow the DOM, multi-window lifecycles, cross-process IPC security boundaries, and dock layouts.

To formally verify that the core concurrency, resource ownership, and layout synchronization protocols preserve causal progress, prevent visual regressions, privilege leaks, and state corruptions, the foundation is specified and verified using **TLA+** (Temporal Logic of Actions) and the **TLC Model Checker**.

---

## Verified Specifications

The formal specifications reside in the [`specs/`](./) directory:

| Specification | Target Component | Formal Properties & Invariants |
| --- | --- | --- |
| [`ScopeHierarchy.tla`](./ScopeHierarchy.tla) | `createScope()` in `src/main/scope.ts` | `TypeOK`, `SingleParent`, `ParentChildConsistency`, `AcyclicOwnership`, `DeadNeverRevives`, `ResourceConservation` |
| [`TrustLeaseGate.tla`](./TrustLeaseGate.tla) | `TrustSet` (`src/internal/trust-set.ts`) & `WireTransport` (`src/internal/wire-transport.ts`) | `TypeOK`, `RefCountExact`, `ClosedScopeHasNoLeases`, `SecurityGateSoundness`, `FanoutSafety` |
| [`DeckPlacementReconciler.tla`](./DeckPlacementReconciler.tla) | `reconcile()` (`src/layout/placement-reconcile.ts`) & `PlacementPublisher` (`src/client/placement-publisher.ts`) | `TypeOK`, `NoOrphanedViews`, `ConsistentVisibility`, `MonotonicProgress` |

Run `pnpm run tla:check` to execute TLC model checking across all specifications and view live explored state counts.

---

## Core Invariants & Safety Guarantees

### 1. Hierarchical Scope Lifecycle & Atomic Adoption (`ScopeHierarchy.tla`)

- **Single-Flight Completion Fence**: `reset()` and `close()` are true completion fences. A concurrent `close()` cleanly upgrades an in-flight `reset()` to terminal teardown without duplicate passes.
- **Cross-Layer LIFO Teardown**: Teardown recursively disposes child sub-scopes before releasing directly-owned resources, guaranteeing no grandchild or child outlives its parent.
- **Single Parent Invariant**: At every point in execution, every active child scope is attached to *exactly one* parent segment.
- **Acyclic Adoption**: `adopt(child, newParent)` verifies that `newParent` is not `child` and cannot reach `child` via ancestor chains, mathematically preventing cycle creation in the lifetime forest.
- **Leak Protection**: Resources registered with `own()` on a dead or closing scope are disposed immediately.

### 2. Sealed Trust Model & Transport Gate Security (`TrustLeaseGate.tla`)

- **Sealed Lease Ownership**: Trust leases can only be minted via `admit(wc, ownerScope)`, ensuring every lease is strictly bound to a `Scope`. When an owner scope resets or closes, all associated leases are revoked.
- **Refcount Exactness**: `refCount[wc]` strictly equals the number of active leases held by live scopes.
- **Disposer Idempotency**: Early manual release followed by parent scope teardown safely no-ops without double-decrementing or resurrecting deleted entries.
- **Defense-in-Depth IPC Gate**: Inbound IPC invokes require both verified sender trust and top main-frame identity. Untrusted senders and nested sub-frames are rejected fail-closed.
- **Fanout Boundary**: Outbound event broadcasts only reach live, trusted WebContents that have not been destroyed.

### 3. Level-Triggered Placement Protocol (`DeckPlacementReconciler.tla`)

- **Epoch & Generation Monotonicity**: Host reconciler strictly rejects snapshots with an older generation (`gen < currentGen`) or stale/duplicate epoch (`gen == currentGen /\ epoch <= lastEpoch`).
- **Anti-Orphan Guarantee**: Across renderer reloads or crashes (generation bump), `actual` view records carry forward. Any view absent from the new generation's desired table is cleanly detached via `scanDetached`, preventing visual leaks or stranded native views.
- **Consistent Visibility**: An unattached native view is never marked visible.

---

## Running Verification

### Prerequisites

A Java Runtime Environment (JRE/JDK 11+) is required to execute the TLC model checker.

Verify Java is available:

```bash
java -version
```

### Run Model Checking

Run all specifications via npm / pnpm:

```bash
pnpm run tla:check
```

Or run via the Node runner directly:

```bash
node scripts/verify-tla.js
```

> **Note on TLC deadlock detection**: TLC by design reports terminal quiescent states (where all queues are drained and no further actions are enabled) as deadlocks. Because event-driven frameworks reach legitimate quiescent states when idle, the runner passes `-deadlock` to focus TLC on full state space exploration and verification of inductive safety invariants.

### Run a Single Specification

```bash
pnpm run tla:check --spec ScopeHierarchy
pnpm run tla:check --spec TrustLeaseGate
pnpm run tla:check --spec DeckPlacementReconciler
```

### Clean Cache and States

```bash
pnpm run tla:clean
```

---

## Model-Based Conformance Testing

To prevent specification drift, automated property-based conformance tests in `src/main/tla-conformance.test.ts` continuously exercise the production TypeScript code under chaotic randomized interleavings (rapid async resets, upgrades, adoptions, trust lease lifecycles, and out-of-order snapshot diffs) to assert that the runtime code satisfies the exact TLA+ safety invariants on every test run.
