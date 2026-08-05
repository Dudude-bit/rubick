/**
 * Semantic role for a Kubernetes status string.
 *
 * Four roles carry every state the app displays. The previous component
 * enumerated ~30 variants, each repeating the same four colour pairs by
 * hand, which is how 137 colour literals accumulated in one file.
 */
export type StatusRole = "ok" | "pending" | "warn" | "err" | "neutral";

const ROLES: Record<StatusRole, readonly string[]> = {
  ok: [
    "running",
    "ready",
    "available",
    "active",
    "succeeded",
    "bound",
    "deployed",
    "true",
  ],
  pending: [
    "pending",
    "waiting",
    "progressing",
    "creating",
    "containercreating",
    "terminating",
    "pendinginstall",
    "pendingupgrade",
    "pendingrollback",
    "uninstalling",
  ],
  warn: ["warning", "degraded", "suspended", "notready", "unhealthy"],
  err: [
    "error",
    "failed",
    "crashloopbackoff",
    "evicted",
    "oomkilled",
    "imagepullbackoff",
    "errimagepull",
    "createcontainerconfigerror",
    "schedulererror",
    "unavailable",
    "false",
  ],
  neutral: [
    "completed",
    "terminated",
    "superseded",
    "uninstalled",
    "unknown",
    "idle",
  ],
};

const LOOKUP = new Map<string, StatusRole>(
  Object.entries(ROLES).flatMap(([role, states]) =>
    states.map((s) => [s, role as StatusRole] as const)
  )
);

/** Kubernetes spells the same state several ways; normalise before lookup. */
function normalize(status: string): string {
  return status.toLowerCase().replace(/[\s_-]/g, "");
}

export function statusRole(status: string): StatusRole {
  return LOOKUP.get(normalize(status)) ?? "neutral";
}
