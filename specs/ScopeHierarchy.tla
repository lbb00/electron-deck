--------------------------- MODULE ScopeHierarchy ---------------------------
(***************************************************************************)
(* Formal specification of hierarchical Scope lifecycle & adopt()         *)
(* from src/main/scope.ts in electron-deck.                                *)
(*                                                                         *)
(* Accurately models:                                                      *)
(* - Active lifetime segment vs in-flight teardown segment                 *)
(* - Single-flight completion fence (reset & close)                        *)
(* - Upgrade from in-flight reset to terminal close (cleaning leftovers)   *)
(* - own() and child() during reset landing in fresh segment               *)
(* - Cross-scope re-parenting via adopt() with ancestor cycle prevention   *)
(* - Non-resurrection guarantee for closed scopes                         *)
(* - Exact resource conservation: no resource is leaked or lost            *)
(***************************************************************************)

EXTENDS Integers, FiniteSets

CONSTANTS
    Scopes,         \* Set of scope IDs, e.g. {"Root", "S1", "S2", "S3"}
    Root,           \* Root scope identifier \in Scopes
    Resources       \* Set of resource IDs, e.g. {"r1", "r2"}

VARIABLES
    alive,          \* [Scopes -> BOOLEAN]
    dead,           \* [Scopes -> BOOLEAN]
    parent,         \* [Scopes -> Scopes \cup {"None"}]
    children,       \* [Scopes -> SUBSET Scopes] (active segment children)
    ownedRes,       \* [Scopes -> SUBSET Resources] (active segment resources)
    oldChildren,    \* [Scopes -> SUBSET Scopes] (segment undergoing teardown)
    oldRes,         \* [Scopes -> SUBSET Resources] (segment undergoing teardown)
    disposedRes,    \* SUBSET Resources
    everOwned,      \* SUBSET Resources (history variable for conservation)
    inFlight        \* [Scopes -> {"none", "reset", "close"}]

vars == <<alive, dead, parent, children, ownedRes, oldChildren, oldRes,
          disposedRes, everOwned, inFlight>>

None == "None"

RECURSIVE AncestorsOf(_, _)
AncestorsOf(s, visited) ==
    IF s = None \/ s \in visited THEN {}
    ELSE LET p == parent[s] IN
         IF p = None THEN {}
         ELSE {p} \cup AncestorsOf(p, visited \cup {s})

Ancestors(s) ==
    AncestorsOf(s, {})

ParentReachable(start, target) ==
    target \in Ancestors(start)

TypeOK ==
    /\ alive \in [Scopes -> BOOLEAN]
    /\ dead \in [Scopes -> BOOLEAN]
    /\ parent \in [Scopes -> Scopes \cup {None}]
    /\ children \in [Scopes -> SUBSET Scopes]
    /\ ownedRes \in [Scopes -> SUBSET Resources]
    /\ oldChildren \in [Scopes -> SUBSET Scopes]
    /\ oldRes \in [Scopes -> SUBSET Resources]
    /\ disposedRes \subseteq Resources
    /\ everOwned \subseteq Resources
    /\ inFlight \in [Scopes -> {"none", "reset", "close"}]

Init ==
    /\ alive = [s \in Scopes |-> s = Root]
    /\ dead = [s \in Scopes |-> FALSE]
    /\ parent = [s \in Scopes |-> None]
    /\ children = [s \in Scopes |-> {}]
    /\ ownedRes = [s \in Scopes |-> {}]
    /\ oldChildren = [s \in Scopes |-> {}]
    /\ oldRes = [s \in Scopes |-> {}]
    /\ disposedRes = {}
    /\ everOwned = {}
    /\ inFlight = [s \in Scopes |-> "none"]

(***************************************************************************)
(* Actions                                                                 *)
(***************************************************************************)

CreateChild(p, c) ==
    /\ p # c
    /\ alive[p]
    /\ ~alive[c]
    /\ ~dead[c]
    /\ parent[c] = None
    /\ c # Root
    /\ alive' = [alive EXCEPT ![c] = TRUE]
    /\ parent' = [parent EXCEPT ![c] = p]
    /\ children' = [children EXCEPT ![p] = @ \cup {c}]
    /\ UNCHANGED <<dead, ownedRes, oldChildren, oldRes, disposedRes, everOwned, inFlight>>

OwnResource(s, r) ==
    /\ r \notin disposedRes
    /\ \A sc \in Scopes : r \notin (ownedRes[sc] \cup oldRes[sc])
    /\ everOwned' = everOwned \cup {r}
    /\ IF alive[s]
       THEN /\ ownedRes' = [ownedRes EXCEPT ![s] = @ \cup {r}]
            /\ UNCHANGED <<alive, dead, parent, children, oldChildren, oldRes, disposedRes, inFlight>>
       ELSE /\ disposedRes' = disposedRes \cup {r}
            /\ UNCHANGED <<alive, dead, parent, children, ownedRes, oldChildren, oldRes, inFlight>>

StartReset(s) ==
    /\ alive[s]
    /\ inFlight[s] = "none"
    /\ inFlight' = [inFlight EXCEPT ![s] = "reset"]
    /\ oldChildren' = [oldChildren EXCEPT ![s] = children[s]]
    /\ oldRes' = [oldRes EXCEPT ![s] = ownedRes[s]]
    /\ children' = [children EXCEPT ![s] = {}]
    /\ ownedRes' = [ownedRes EXCEPT ![s] = {}]
    /\ UNCHANGED <<alive, dead, parent, disposedRes, everOwned>>

FinishReset(s) ==
    /\ inFlight[s] = "reset"
    /\ LET oldSubtree == oldChildren[s] \cup { d \in Scopes : \E c \in oldChildren[s] : c = d \/ ParentReachable(d, c) }
           teardownRes == oldRes[s] \cup UNION { ownedRes[d] \cup oldRes[d] : d \in oldSubtree }
       IN
       /\ alive' = [sc \in Scopes |-> IF sc \in oldSubtree THEN FALSE ELSE alive[sc]]
       /\ dead' = [sc \in Scopes |-> IF sc \in oldSubtree THEN TRUE ELSE dead[sc]]
       /\ parent' = [sc \in Scopes |-> IF sc \in oldSubtree THEN None ELSE parent[sc]]
       /\ children' = [sc \in Scopes |-> IF sc \in oldSubtree THEN {} ELSE children[sc] \ oldSubtree]
       /\ oldChildren' = [sc \in Scopes |-> IF sc = s \/ sc \in oldSubtree THEN {} ELSE oldChildren[sc] \ oldSubtree]
       /\ ownedRes' = [sc \in Scopes |-> IF sc \in oldSubtree THEN {} ELSE ownedRes[sc]]
       /\ oldRes' = [sc \in Scopes |-> IF sc = s \/ sc \in oldSubtree THEN {} ELSE oldRes[sc]]
       /\ disposedRes' = disposedRes \cup teardownRes
       /\ inFlight' = [sc \in Scopes |-> IF sc = s \/ sc \in oldSubtree THEN "none" ELSE inFlight[sc]]
       /\ UNCHANGED <<everOwned>>

StartClose(s) ==
    /\ alive[s]
    /\ inFlight[s] = "none"
    /\ alive' = [alive EXCEPT ![s] = FALSE]
    /\ inFlight' = [inFlight EXCEPT ![s] = "close"]
    /\ oldChildren' = [oldChildren EXCEPT ![s] = children[s]]
    /\ oldRes' = [oldRes EXCEPT ![s] = ownedRes[s]]
    /\ children' = [children EXCEPT ![s] = {}]
    /\ ownedRes' = [ownedRes EXCEPT ![s] = {}]
    /\ UNCHANGED <<dead, parent, disposedRes, everOwned>>

UpgradeResetToClose(s) ==
    /\ inFlight[s] = "reset"
    /\ alive' = [alive EXCEPT ![s] = FALSE]
    /\ inFlight' = [inFlight EXCEPT ![s] = "close"]
    /\ UNCHANGED <<dead, parent, children, ownedRes, oldChildren, oldRes, disposedRes, everOwned>>

FinishClose(s) ==
    /\ inFlight[s] = "close"
    /\ LET affectedOld == oldChildren[s] \cup { d \in Scopes : \E c \in oldChildren[s] : c = d \/ ParentReachable(d, c) }
           affectedNew == children[s] \cup { d \in Scopes : \E c \in children[s] : c = d \/ ParentReachable(d, c) }
           allAffected == affectedOld \cup affectedNew \cup {s}
           allRes == oldRes[s] \cup ownedRes[s] \cup UNION { ownedRes[sc] \cup oldRes[sc] : sc \in (affectedOld \cup affectedNew) }
           p == parent[s]
       IN
       /\ alive' = [sc \in Scopes |-> IF sc \in allAffected THEN FALSE ELSE alive[sc]]
       /\ dead' = [sc \in Scopes |-> IF sc \in allAffected THEN TRUE ELSE dead[sc]]
       /\ parent' = [sc \in Scopes |-> IF sc \in allAffected THEN None ELSE parent[sc]]
       /\ children' = [sc \in Scopes |->
            IF sc \in allAffected THEN {}
            ELSE IF sc = p THEN children[sc] \ {s}
            ELSE children[sc] \ allAffected]
       /\ oldChildren' = [sc \in Scopes |->
            IF sc \in allAffected THEN {}
            ELSE IF sc = p THEN oldChildren[sc] \ {s}
            ELSE oldChildren[sc] \ allAffected]
       /\ ownedRes' = [sc \in Scopes |-> IF sc \in allAffected THEN {} ELSE ownedRes[sc]]
       /\ oldRes' = [sc \in Scopes |-> IF sc \in allAffected THEN {} ELSE oldRes[sc]]
       /\ disposedRes' = disposedRes \cup allRes
       /\ inFlight' = [sc \in Scopes |-> IF sc \in allAffected THEN "none" ELSE inFlight[sc]]
       /\ UNCHANGED <<everOwned>>

Adopt(donor, child, newParent) ==
    /\ donor # newParent
    /\ inFlight[donor] = "none"
    /\ inFlight[newParent] = "none"
    /\ alive[donor]
    /\ alive[newParent]
    /\ child \in children[donor]
    /\ parent[child] = donor
    /\ child # newParent
    /\ ~ParentReachable(newParent, child)
    /\ children' = [children EXCEPT ![donor] = @ \ {child}, ![newParent] = @ \cup {child}]
    /\ parent' = [parent EXCEPT ![child] = newParent]
    /\ UNCHANGED <<alive, dead, ownedRes, oldChildren, oldRes, disposedRes, everOwned, inFlight>>

Next ==
    \/ \E p, c \in Scopes: CreateChild(p, c)
    \/ \E s \in Scopes, r \in Resources: OwnResource(s, r)
    \/ \E s \in Scopes: StartReset(s)
    \/ \E s \in Scopes: FinishReset(s)
    \/ \E s \in Scopes: StartClose(s)
    \/ \E s \in Scopes: UpgradeResetToClose(s)
    \/ \E s \in Scopes: FinishClose(s)
    \/ \E donor, child, newParent \in Scopes: Adopt(donor, child, newParent)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Formal Safety Invariants                                                *)
(***************************************************************************)

SingleParent ==
    \A s \in Scopes \ {Root}:
        (alive[s] /\ parent[s] # None) =>
            /\ parent[s] \in Scopes
            /\ (s \in children[parent[s]] \/ s \in oldChildren[parent[s]])
            /\ \A p1, p2 \in Scopes:
                ((s \in (children[p1] \cup oldChildren[p1])) /\ (s \in (children[p2] \cup oldChildren[p2]))) => p1 = p2

ParentChildConsistency ==
    \A p \in Scopes:
        \A c \in (children[p] \cup oldChildren[p]):
            parent[c] = p

AcyclicOwnership ==
    \A s \in Scopes:
        ~ParentReachable(s, s)

DeadNeverRevives ==
    \A s \in Scopes:
        dead[s] =>
            /\ ~alive[s]
            /\ inFlight[s] = "none"
            /\ children[s] = {}
            /\ ownedRes[s] = {}
            /\ oldChildren[s] = {}
            /\ oldRes[s] = {}

ResourceConservation ==
    /\ everOwned = (UNION { ownedRes[s] : s \in Scopes }) \cup (UNION { oldRes[s] : s \in Scopes }) \cup disposedRes
    /\ (UNION { ownedRes[s] : s \in Scopes }) \cap (UNION { oldRes[s] : s \in Scopes }) = {}
    /\ ((UNION { ownedRes[s] : s \in Scopes }) \cup (UNION { oldRes[s] : s \in Scopes })) \cap disposedRes = {}

=============================================================================
