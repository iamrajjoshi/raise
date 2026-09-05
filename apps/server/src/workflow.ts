import type { Lifecycle, PendingActionKind, RaisePermissions, Role } from "@raise/protocol";

export function otherRole(role: Role): Role {
  return role === "human" ? "agent" : "human";
}

export function initialWorkflow(origin: Role): {
  targetRole: Role;
  pendingAction: PendingActionKind;
} {
  return {
    targetRole: otherRole(origin),
    pendingAction: origin === "human" ? "perform_work" : "provide_context",
  };
}

export function permissionsFor(
  lifecycle: Lifecycle,
  waitingOn: Role | null,
  pendingAction: PendingActionKind | null,
  viewerRole: Role,
): RaisePermissions {
  const canAct = lifecycle === "open" && waitingOn === viewerRole;
  return {
    canReply: canAct && pendingAction === "provide_context",
    canPostResult: canAct && (pendingAction === "perform_work" || pendingAction === "make_changes"),
    canReview: canAct && pendingAction === "review_result" && viewerRole === "human",
    canComment: lifecycle === "open",
  };
}
