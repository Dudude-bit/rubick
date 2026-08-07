import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/**
 * Semantic role for a Kubernetes status string.
 *
 * Four roles carry every state the app displays. The previous component
 * enumerated ~30 variants, each repeating the same four colour pairs by
 * hand, which is how 137 colour literals accumulated in one file.
 */
export type StatusRole = "ok" | "pending" | "warn" | "err" | "neutral";

/**
 * Shape, not decoration. Severity has to survive greyscale and the roughly
 * one reader in twelve who cannot separate the red from the green, so the
 * glyphs are chosen to differ in outline: a tick, a clock, a triangle, a
 * cross, a dash.
 *
 * They live beside the roles rather than in `StatusBadge` because a badge is
 * not the only place a role is drawn — a condition row, a container block and
 * a pod picker all say the same five things, and five copies of this table is
 * how `pending` came to be amber in one of them and blue in the rest.
 */
export const ROLE_ICON: Record<StatusRole, LucideIcon> = {
  ok: CircleCheck,
  pending: Clock,
  warn: TriangleAlert,
  err: CircleX,
  neutral: CircleMinus,
};

export const ROLE_TEXT: Record<StatusRole, string> = {
  ok: "text-ok",
  pending: "text-info",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-mut",
};

export const ROLE_DOT: Record<StatusRole, string> = {
  ok: "bg-ok",
  pending: "bg-info",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-fg-fnt",
};

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
    "podinitializing",
    "schedulinggated",
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

/** `Init:2/3` — an init container is still working, and none has failed. */
const INIT_PROGRESS = /^\d+\/\d+$/;
/** What kubectl prints when a termination carried no reason of its own. */
const EXIT = /^exitcode:(\d+)$/;
const SIGNAL = /^signal:\d+$/;

export function statusRole(status: string): StatusRole {
  let key = normalize(status);
  // kubectl prefixes the whole init phase, so `Init:ImagePullBackOff` is
  // an image that cannot be pulled and has to read as one.
  if (key.startsWith("init:")) {
    key = key.slice(5);
    if (INIT_PROGRESS.test(key)) return "pending";
  }
  const exit = EXIT.exec(key);
  if (exit) return exit[1] === "0" ? "neutral" : "err";
  if (SIGNAL.test(key)) return "err";
  return LOOKUP.get(key) ?? "neutral";
}
