---------------------- MODULE DeckPlacementReconciler ----------------------
(***************************************************************************)
(* Formal specification of Level-Triggered Placement Protocol              *)
(* between PlacementPublisher (src/client/placement-publisher.ts)         *)
(* and PlacementReconciler (src/layout/placement-reconcile.ts).            *)
(*                                                                         *)
(* Accurately proves:                                                      *)
(* - Anti-Orphan: Any native view attached in actual state MUST be defined *)
(*   in the latest accepted snapshot (scanDetached guarantee)              *)
(* - Monotonic Progress: Reconciler never regresses generation or epoch    *)
(* - Consistent Visibility: A view is only visible when attached           *)
(***************************************************************************)

EXTENDS Integers, FiniteSets

CONSTANTS
    Views,          \* Finite set of View IDs, e.g. {"v1", "v2"}
    MaxGen,         \* Max generation bound, e.g. 1
    MaxEpoch        \* Max epoch per generation bound, e.g. 3

VARIABLES
    pubGen,             \* 0..MaxGen
    pubEpoch,           \* 0..MaxEpoch
    pubDirty,           \* BOOLEAN (microtask coalesce flag)
    pubViews,           \* [Views -> [defined: BOOLEAN, visible: BOOLEAN]]
    channel,            \* Set of in-flight snapshots
    recGen,             \* 0..MaxGen
    recLastEpoch,       \* -1..MaxEpoch
    recActual,          \* [Views -> [attached: BOOLEAN, visible: BOOLEAN]]
    lastAcceptedViews,  \* [Views -> [defined: BOOLEAN, visible: BOOLEAN]]
    hasAcceptedAny      \* BOOLEAN

vars == <<pubGen, pubEpoch, pubDirty, pubViews, channel, recGen, recLastEpoch,
          recActual, lastAcceptedViews, hasAcceptedAny>>

ViewStates == [
    defined: BOOLEAN,
    visible: BOOLEAN
]

ActualStates == [
    attached: BOOLEAN,
    visible: BOOLEAN
]

TypeOK ==
    /\ pubGen \in 0..MaxGen
    /\ pubEpoch \in 0..MaxEpoch
    /\ pubDirty \in BOOLEAN
    /\ pubViews \in [Views -> ViewStates]
    /\ recGen \in 0..MaxGen
    /\ recLastEpoch \in -1..MaxEpoch
    /\ recActual \in [Views -> ActualStates]
    /\ lastAcceptedViews \in [Views -> ViewStates]
    /\ hasAcceptedAny \in BOOLEAN
    /\ channel \subseteq [
        generation: 0..MaxGen,
        epoch: 0..MaxEpoch,
        views: [Views -> ViewStates]
       ]

Init ==
    /\ pubGen = 0
    /\ pubEpoch = 0
    /\ pubDirty = FALSE
    /\ pubViews = [v \in Views |-> [defined |-> FALSE, visible |-> FALSE]]
    /\ channel = {}
    /\ recGen = 0
    /\ recLastEpoch = -1
    /\ recActual = [v \in Views |-> [attached |-> FALSE, visible |-> FALSE]]
    /\ lastAcceptedViews = [v \in Views |-> [defined |-> FALSE, visible |-> FALSE]]
    /\ hasAcceptedAny = FALSE

(***************************************************************************)
(* Actions                                                                 *)
(***************************************************************************)

PublisherSet(v, vis) ==
    /\ pubEpoch < MaxEpoch
    /\ pubViews' = [pubViews EXCEPT ![v] = [defined |-> TRUE, visible |-> vis]]
    /\ pubDirty' = TRUE
    /\ UNCHANGED <<pubGen, pubEpoch, channel, recGen, recLastEpoch, recActual,
                   lastAcceptedViews, hasAcceptedAny>>

PublisherRemove(v) ==
    /\ pubEpoch < MaxEpoch
    /\ pubViews[v].defined
    /\ pubViews' = [pubViews EXCEPT ![v] = [defined |-> FALSE, visible |-> FALSE]]
    /\ pubDirty' = TRUE
    /\ UNCHANGED <<pubGen, pubEpoch, channel, recGen, recLastEpoch, recActual,
                   lastAcceptedViews, hasAcceptedAny>>

PublisherFlush ==
    /\ pubDirty
    /\ pubEpoch < MaxEpoch
    /\ LET snapshot == [
            generation |-> pubGen,
            epoch |-> pubEpoch,
            views |-> pubViews
        ]
       IN
       /\ channel' = channel \cup {snapshot}
       /\ pubEpoch' = pubEpoch + 1
       /\ pubDirty' = FALSE
       /\ UNCHANGED <<pubGen, pubViews, recGen, recLastEpoch, recActual,
                      lastAcceptedViews, hasAcceptedAny>>

PublisherReload ==
    /\ pubGen < MaxGen
    /\ pubGen' = pubGen + 1
    /\ pubEpoch' = 0
    /\ pubDirty' = FALSE
    /\ pubViews' = [v \in Views |-> [defined |-> FALSE, visible |-> FALSE]]
    /\ UNCHANGED <<channel, recGen, recLastEpoch, recActual, lastAcceptedViews,
                   hasAcceptedAny>>

ReconcilePacket(pkt) ==
    /\ pkt \in channel
    /\ IF pkt.generation < recGen THEN
           \* Stale generation: drop outright
           UNCHANGED <<pubGen, pubEpoch, pubDirty, pubViews, channel, recGen,
                         recLastEpoch, recActual, lastAcceptedViews, hasAcceptedAny>>
       ELSE IF pkt.generation = recGen /\ pkt.epoch <= recLastEpoch THEN
           \* Stale or duplicate epoch in current generation: drop
           UNCHANGED <<pubGen, pubEpoch, pubDirty, pubViews, channel, recGen,
                         recLastEpoch, recActual, lastAcceptedViews, hasAcceptedAny>>
       ELSE
           \* Accept and reconcile:
           LET nextActual == [v \in Views |->
                   IF ~pkt.views[v].defined THEN
                       \* scanDetached: view not in desired table is detached
                       [attached |-> FALSE, visible |-> FALSE]
                   ELSE IF ~pkt.views[v].visible THEN
                       \* view is desired but hidden: preserve attach, mark hidden
                       [attached |-> recActual[v].attached, visible |-> FALSE]
                   ELSE
                       \* view is desired and visible: attach and show
                       [attached |-> TRUE, visible |-> TRUE]
               ]
           IN
           /\ recGen' = pkt.generation
           /\ recLastEpoch' = pkt.epoch
           /\ recActual' = nextActual
           /\ lastAcceptedViews' = pkt.views
           /\ hasAcceptedAny' = TRUE
           /\ UNCHANGED <<pubGen, pubEpoch, pubDirty, pubViews, channel>>

Next ==
    \/ \E v \in Views, vis \in {TRUE, FALSE}: PublisherSet(v, vis)
    \/ \E v \in Views: PublisherRemove(v)
    \/ PublisherFlush
    \/ PublisherReload
    \/ \E pkt \in channel: ReconcilePacket(pkt)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Formal Safety Invariants & Temporal Properties                           *)
(***************************************************************************)

NoOrphanedViews ==
    \* If reconciler has accepted any snapshot, every attached view MUST be defined
    \* in the latest accepted snapshot (guaranteed by scanDetached)
    hasAcceptedAny =>
        \A v \in Views:
            recActual[v].attached => lastAcceptedViews[v].defined

ConsistentVisibility ==
    \A v \in Views:
        recActual[v].visible => recActual[v].attached

MonotonicProgress ==
    [][(recGen' > recGen) \/ (recGen' = recGen /\ recLastEpoch' >= recLastEpoch)]_vars

=============================================================================
