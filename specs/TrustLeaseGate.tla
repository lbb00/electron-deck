--------------------------- MODULE TrustLeaseGate ---------------------------
(***************************************************************************)
(* Formal specification of TrustSet (src/internal/trust-set.ts)            *)
(* and WireTransport security gates (src/internal/wire-transport.ts).      *)
(*                                                                         *)
(* Accurately models:                                                      *)
(* - Scope-owned lease lifecycle with two-phase teardown (alive -> closing *)
(*   -> closed) and reset revocation                                       *)
(* - Strict refcount exactness across concurrent leases & early disposal   *)
(* - Non-vacuous wire transport gate: untrusted senders, sub-frames, and   *)
(*   null-frames are rejected fail-closed                                  *)
(* - Fanout delivery boundary: only live trusted surfaces receive events   *)
(* - Leak-protection: admitting against a dead scope immediately disposes  *)
(***************************************************************************)

EXTENDS Integers, FiniteSets

CONSTANTS
    WebContents,    \* Finite set of WebContents, e.g. {"wc1", "wc2"}
    Scopes,         \* Finite set of owner Scopes, e.g. {"s1", "s2"}
    MaxLeases       \* Maximum number of leases to grant in model run

VARIABLES
    wireState,          \* {"idle", "started", "disposed"}
    scopeState,         \* [Scopes -> {"alive", "closing", "closed"}]
    wcDestroyed,        \* [WebContents -> BOOLEAN]
    refCount,           \* [WebContents -> 0..MaxLeases]
    activeLeases,       \* Set of [id: 1..MaxLeases, wc: WebContents, owner: Scopes]
    disposedLeaseIds,   \* SUBSET (1..MaxLeases)
    nextLeaseId,        \* 1..(MaxLeases + 1)
    dispatchedInvokes,  \* Set of [wc: WebContents, frame: {"MainFrame", "SubFrame", "NullFrame"}, wireStateAtInvoke: STRING, refCountAtInvoke: 0..MaxLeases]
    fanoutDeliveries    \* Set of [wc: WebContents, wireStateAtFanout: STRING, refCountAtFanout: 0..MaxLeases, destroyedAtFanout: BOOLEAN]

vars == <<wireState, scopeState, wcDestroyed, refCount, activeLeases,
          disposedLeaseIds, nextLeaseId, dispatchedInvokes, fanoutDeliveries>>

FrameTypes == {"MainFrame", "SubFrame", "NullFrame"}

TypeOK ==
    /\ wireState \in {"idle", "started", "disposed"}
    /\ scopeState \in [Scopes -> {"alive", "closing", "closed"}]
    /\ wcDestroyed \in [WebContents -> BOOLEAN]
    /\ refCount \in [WebContents -> 0..MaxLeases]
    /\ activeLeases \subseteq [id: 1..MaxLeases, wc: WebContents, owner: Scopes]
    /\ disposedLeaseIds \subseteq 1..MaxLeases
    /\ nextLeaseId \in 1..(MaxLeases + 1)
    /\ dispatchedInvokes \subseteq [
        wc: WebContents,
        frame: FrameTypes,
        wireStateAtInvoke: {"idle", "started", "disposed"},
        refCountAtInvoke: 0..MaxLeases
       ]
    /\ fanoutDeliveries \subseteq [
        wc: WebContents,
        wireStateAtFanout: {"idle", "started", "disposed"},
        refCountAtFanout: 0..MaxLeases,
        destroyedAtFanout: BOOLEAN
       ]

Init ==
    /\ wireState = "idle"
    /\ scopeState = [s \in Scopes |-> "alive"]
    /\ wcDestroyed = [w \in WebContents |-> FALSE]
    /\ refCount = [w \in WebContents |-> 0]
    /\ activeLeases = {}
    /\ disposedLeaseIds = {}
    /\ nextLeaseId = 1
    /\ dispatchedInvokes = {}
    /\ fanoutDeliveries = {}

(***************************************************************************)
(* Actions                                                                 *)
(***************************************************************************)

WireStart ==
    /\ wireState = "idle"
    /\ wireState' = "started"
    /\ UNCHANGED <<scopeState, wcDestroyed, refCount, activeLeases,
                   disposedLeaseIds, nextLeaseId, dispatchedInvokes,
                   fanoutDeliveries>>

WireDispose ==
    /\ wireState = "started"
    /\ wireState' = "disposed"
    /\ UNCHANGED <<scopeState, wcDestroyed, refCount, activeLeases,
                   disposedLeaseIds, nextLeaseId, dispatchedInvokes,
                   fanoutDeliveries>>

Admit(wc, owner) ==
    /\ nextLeaseId <= MaxLeases
    /\ nextLeaseId' = nextLeaseId + 1
    /\ IF scopeState[owner] = "alive"
       THEN /\ activeLeases' = activeLeases \cup {[id |-> nextLeaseId, wc |-> wc, owner |-> owner]}
            /\ refCount' = [refCount EXCEPT ![wc] = @ + 1]
            /\ UNCHANGED <<wireState, scopeState, wcDestroyed, disposedLeaseIds, dispatchedInvokes, fanoutDeliveries>>
       ELSE \* Dead scope: disposeLate immediately drops the lease
            /\ disposedLeaseIds' = disposedLeaseIds \cup {nextLeaseId}
            /\ UNCHANGED <<wireState, scopeState, wcDestroyed, refCount, activeLeases, dispatchedInvokes, fanoutDeliveries>>

EarlyDisposeLease(lease) ==
    /\ lease \in activeLeases
    /\ activeLeases' = activeLeases \ {lease}
    /\ disposedLeaseIds' = disposedLeaseIds \cup {lease.id}
    /\ refCount' = [refCount EXCEPT ![lease.wc] = @ - 1]
    /\ UNCHANGED <<wireState, scopeState, wcDestroyed, nextLeaseId,
                   dispatchedInvokes, fanoutDeliveries>>

StartCloseScope(s) ==
    /\ scopeState[s] = "alive"
    /\ scopeState' = [scopeState EXCEPT ![s] = "closing"]
    /\ UNCHANGED <<wireState, wcDestroyed, refCount, activeLeases,
                   disposedLeaseIds, nextLeaseId, dispatchedInvokes,
                   fanoutDeliveries>>

FinishCloseScope(s) ==
    /\ scopeState[s] = "closing"
    /\ scopeState' = [scopeState EXCEPT ![s] = "closed"]
    /\ LET released == { l \in activeLeases : l.owner = s } IN
       /\ activeLeases' = activeLeases \ released
       /\ disposedLeaseIds' = disposedLeaseIds \cup { l.id : l \in released }
       /\ refCount' = [wc \in WebContents |->
            refCount[wc] - Cardinality({ l \in released : l.wc = wc })]
       /\ UNCHANGED <<wireState, wcDestroyed, nextLeaseId,
                      dispatchedInvokes, fanoutDeliveries>>

ResetScope(s) ==
    /\ scopeState[s] = "alive"
    /\ LET released == { l \in activeLeases : l.owner = s } IN
       /\ activeLeases' = activeLeases \ released
       /\ disposedLeaseIds' = disposedLeaseIds \cup { l.id : l \in released }
       /\ refCount' = [wc \in WebContents |->
            refCount[wc] - Cardinality({ l \in released : l.wc = wc })]
       /\ UNCHANGED <<wireState, scopeState, wcDestroyed, nextLeaseId,
                      dispatchedInvokes, fanoutDeliveries>>

DestroyWebContents(wc) ==
    /\ ~wcDestroyed[wc]
    /\ wcDestroyed' = [wcDestroyed EXCEPT ![wc] = TRUE]
    /\ UNCHANGED <<wireState, scopeState, refCount, activeLeases,
                   disposedLeaseIds, nextLeaseId, dispatchedInvokes,
                   fanoutDeliveries>>

InvokeIpc(wc, frame) ==
    /\ IF wireState = "started" /\ refCount[wc] > 0 /\ frame = "MainFrame"
          THEN dispatchedInvokes' = dispatchedInvokes \cup {[
                wc |-> wc,
                frame |-> frame,
                wireStateAtInvoke |-> wireState,
                refCountAtInvoke |-> refCount[wc]
               ]}
          ELSE UNCHANGED dispatchedInvokes
    /\ UNCHANGED <<wireState, scopeState, wcDestroyed, refCount, activeLeases,
                   disposedLeaseIds, nextLeaseId, fanoutDeliveries>>

BroadcastFanout ==
    /\ wireState = "started"
    /\ LET recipients == { [
            wc |-> w,
            wireStateAtFanout |-> wireState,
            refCountAtFanout |-> refCount[w],
            destroyedAtFanout |-> wcDestroyed[w]
           ] : w \in { target \in WebContents : refCount[target] > 0 /\ ~wcDestroyed[target] } } IN
       /\ fanoutDeliveries' = fanoutDeliveries \cup recipients
       /\ UNCHANGED <<wireState, scopeState, wcDestroyed, refCount, activeLeases,
                      disposedLeaseIds, nextLeaseId, dispatchedInvokes>>

Next ==
    \/ WireStart
    \/ WireDispose
    \/ \E wc \in WebContents, s \in Scopes: Admit(wc, s)
    \/ \E l \in activeLeases: EarlyDisposeLease(l)
    \/ \E s \in Scopes: StartCloseScope(s)
    \/ \E s \in Scopes: FinishCloseScope(s)
    \/ \E s \in Scopes: ResetScope(s)
    \/ \E wc \in WebContents: DestroyWebContents(wc)
    \/ \E wc \in WebContents, f \in FrameTypes: InvokeIpc(wc, f)
    \/ BroadcastFanout

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Formal Safety Invariants                                                *)
(***************************************************************************)

RefCountExact ==
    \A wc \in WebContents:
        refCount[wc] = Cardinality({ l \in activeLeases: l.wc = wc })

ClosedScopeHasNoLeases ==
    \A s \in Scopes:
        scopeState[s] = "closed" => ~(\E l \in activeLeases: l.owner = s)

SecurityGateSoundness ==
    \A inv \in dispatchedInvokes:
        /\ inv.frame = "MainFrame"
        /\ inv.wireStateAtInvoke = "started"
        /\ inv.refCountAtInvoke > 0

FanoutSafety ==
    \A del \in fanoutDeliveries:
        /\ del.wireStateAtFanout = "started"
        /\ del.refCountAtFanout > 0
        /\ ~del.destroyedAtFanout

=============================================================================
