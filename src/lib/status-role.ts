import {
  Check,
  Clock,
  Minus,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * Semantic role for a Kubernetes status string. These five carry every state
 * the app displays; nothing picks a status colour by hand.
 */
export type StatusRole = "ok" | "pending" | "warn" | "err" | "neutral";

/**
 * Shape, not decoration. Severity has to survive greyscale and the roughly
 * one reader in twelve who cannot separate the red from the green, so the
 * glyphs differ in *silhouette*: a diagonal V, a round face, a triangle, a
 * cross, a line.
 *
 * Not the circled variants (`CircleCheck`, `CircleX`, `CircleMinus`): at the
 * 10px these are drawn at the ring is the whole glyph, leaving ok and err one
 * two-pixel smudge apart with hue doing all the work the shape should.
 *
 * They live beside the roles rather than in `StatusBadge` because a badge is
 * not the only place a role is drawn — a condition row, a container block and
 * a pod picker all say the same five things, and five copies of this table is
 * how `pending` came to be amber in one of them and blue in the rest.
 */
export const ROLE_ICON: Record<StatusRole, LucideIcon> = {
  ok: Check,
  pending: Clock,
  warn: TriangleAlert,
  err: X,
  neutral: Minus,
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
    // The revision a Deployment is on, against the "superseded" ones below.
    "current",
    "true",
    // Gateway API: a controller took the object and it is working.
    "accepted",
    "programmed",
    "claimed",
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
  warn: [
    "warning",
    "degraded",
    "suspended",
    "notready",
    "unhealthy",
    // `kubectl get nodes` spells a cordoned node exactly this way, and a
    // reader matches the word against their terminal. Amber, not red: a
    // cordon is somebody's decision, not a fault.
    "ready,schedulingdisabled",
    // A PersistentVolume whose claim was deleted. The data is still there
    // and nothing new can bind to it until somebody reclaims it, so it is a
    // volume waiting on a person — amber, and certainly not the grey dash an
    // unlisted status gets.
    "released",
  ],
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
    // Gateway API: a controller looked and said no.
    "refused",
    // A PersistentVolumeClaim whose volume is gone. Every pod that mounts it
    // fails to start, which is as broken as this list gets.
    "lost",
  ],
  neutral: [
    "completed",
    "terminated",
    "superseded",
    "uninstalled",
    "unknown",
    "idle",
    // Gateway API: no controller has claimed the class — not a fault, and
    // not health either.
    "unclaimed",
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
