/**
 * "Most likely", said from what the app read and no further.
 *
 * A pod in trouble has a reason the kubelet wrote and, behind it, a chain
 * the app can follow: the last lines before the exit name an address, the
 * address is a Service or a sidecar or something outside, the Service has
 * endpoints or not. Everything here is read; nothing is probed. Every
 * sentence that goes past the reading says "probably" or "usually", and a
 * test on the catalogue holds it to that.
 */

import type {
  ContainerInfo,
  EventInfo,
  PodInfo,
  TerminationInfo,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import { formatMemory } from "@/lib/k8s-quantity";

export type HintKey = keyof typeof en.hints;

export interface HintSaying {
  key: HintKey;
  /**
   * A value may itself be a {@link HintSaying}: no language can hand
   * another a substring of its own plural. `{n} restarts` in the outer
   * string gets English wrong at one and Russian wrong at every number,
   * so the count is its own sentence and is chosen first.
   */
  values?: Record<string, string | number | HintSaying>;
}

/** A count as its own sentence, for a number inside another one. */
/**
 * A saying in words, inner sayings first.
 *
 * A value may itself be a {@link HintSaying} — no language can hand another
 * a substring of its own plural — so this resolves the inside before the
 * outside. It lives here because the panel says these sentences on screen
 * and the report writes the same ones into a file: two readers of one rule,
 * which is how they drift.
 */
export function sayingWords(
  saying: HintSaying,
  t: (
    section: "hints",
    key: HintKey,
    values?: Record<string, string | number>
  ) => string
): string {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(saying.values ?? {}))
    values[name] =
      typeof value === "object" && value !== null
        ? sayingWords(value, t)
        : value;
  return t("hints", saying.key, values);
}

export function counted(key: HintKey, n: number): HintSaying {
  return { key, values: { n } };
}

export type Trouble =
  | {
      reason: "crashLoop";
      container: string;
      exit: TerminationInfo | null;
      restarts: number;
    }
  | {
      reason: "oomKilled";
      container: string;
      limit: string | null;
      restarts: number;
    }
  | {
      reason: "imagePull";
      container: string;
      image: string;
      message: string | null;
    }
  | {
      reason: "failedMount";
      volume: string | null;
      message: string | null;
      count: number;
    }
  | {
      reason: "pending";
      message: string | null;
      count: number;
      sameEachTime: boolean;
    }
  | {
      reason: "probeFailed";
      container: string | null;
      probe: "readiness" | "liveness" | "startup" | null;
      message: string | null;
      count: number;
    };

const PULL_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
]);

function occurrences(event: EventInfo): number {
  return Math.max(1, event.count ?? 1);
}

function latest(events: EventInfo[], reason: string): EventInfo | undefined {
  return [...events]
    .filter((e) => e.reason === reason)
    .sort((a, b) =>
      (a.lastTimestamp ?? "").localeCompare(b.lastTimestamp ?? "")
    )
    .at(-1);
}

function probeOf(
  message: string | null
): Trouble extends infer T
  ? T extends { probe: infer P }
    ? P
    : never
  : never {
  const word = /^(Readiness|Liveness|Startup) probe/i.exec(message ?? "")?.[1];
  return (word?.toLowerCase() as "readiness" | "liveness" | "startup") ?? null;
}

/**
 * The one thing wrong with the pod, in order of how loudly it stops the
 * pod: a container that cannot stay up, one killed for memory, an image
 * that will not pull, a volume that will not mount, a pod nothing will
 * schedule, a probe the kubelet keeps failing.
 */
export function troubleOf(pod: PodInfo, events: EventInfo[]): Trouble | null {
  const all = [...pod.initContainers, ...pod.containers];
  // Before the crash loop, not after it. A container killed for memory
  // under `restartPolicy: Always` spends nearly all its time in
  // CrashLoopBackOff, so this arm was unreachable for exactly the pods it
  // was written for — and the Containers tab on the same page said
  // OOMKilled while this panel said "cannot stay up".
  const oom = all.find(
    (c) =>
      c.lastTerminated?.reason === "OOMKilled" &&
      (c.restartCount > 0 || c.state.type !== "running") &&
      !stale(c.lastTerminated.finishedAt, pod)
  );
  if (oom) {
    return {
      reason: "oomKilled",
      container: oom.name,
      limit: limitOf(pod, oom),
      restarts: oom.restartCount,
    };
  }
  const crashing = all.find(
    (c) => c.state.type === "waiting" && c.state.reason === "CrashLoopBackOff"
  );
  if (crashing) {
    return {
      reason: "crashLoop",
      container: crashing.name,
      exit: crashing.lastTerminated,
      restarts: crashing.restartCount,
    };
  }
  const pulling = all.find(
    (c) => c.state.type === "waiting" && PULL_REASONS.has(c.state.reason ?? "")
  );
  if (pulling) {
    const failed = latest(
      events.filter((e) => /pull/i.test(e.message ?? "")),
      "Failed"
    );
    return {
      reason: "imagePull",
      container: pulling.name,
      image: pulling.image,
      message: failed?.message ?? null,
    };
  }
  // Only while something is still waiting on it. An hour-old FailedMount
  // on a pod that has been Running since put a permanent trouble panel,
  // in the present tense, on the Overview of a healthy pod.
  const waiting = all.some((c) => c.state.type === "waiting");
  const mount =
    waiting || pod.status.phase !== "Running"
      ? (latest(events, "FailedMount") ?? latest(events, "FailedAttachVolume"))
      : null;
  if (mount) {
    return {
      reason: "failedMount",
      volume: /volume "([^"]+)"/.exec(mount.message ?? "")?.[1] ?? null,
      message: mount.message,
      count: occurrences(mount),
    };
  }
  const scheduling = events.filter((e) => e.reason === "FailedScheduling");
  if (pod.status.phase === "Pending" && scheduling.length > 0) {
    const last = latest(scheduling, "FailedScheduling")!;
    return {
      reason: "pending",
      message: last.message,
      count: scheduling.reduce((sum, e) => sum + occurrences(e), 0),
      sameEachTime: new Set(scheduling.map((e) => e.message ?? "")).size === 1,
    };
  }
  const unhealthy = latest(events, "Unhealthy");
  if (unhealthy && !pod.status.ready) {
    return {
      reason: "probeFailed",
      container: null,
      probe: probeOf(unhealthy.message),
      message: unhealthy.message,
      count: events
        .filter((e) => e.reason === "Unhealthy")
        .reduce((sum, e) => sum + occurrences(e), 0),
    };
  }
  return null;
}

/**
 * A termination too old to be what is wrong now: the pod has been up since.
 * Without it a single OOM kill days ago left a permanent "is killed for
 * using more memory" panel on a healthy pod.
 */
function stale(finishedAt: string | null, pod: PodInfo): boolean {
  if (!finishedAt) return false;
  const ended = Date.parse(finishedAt);
  if (Number.isNaN(ended)) return false;
  return pod.status.ready && Date.now() - ended > STALE_TROUBLE_MS;
}

/** Older than this and still ready: whatever it was, it is over. */
const STALE_TROUBLE_MS = 30 * 60_000;

/**
 * The pod's memory limit in words.
 *
 * `pod.memoryLimits` is a plain byte count, and every container's limit
 * added up — so the panel printed "1073741824" and called it this
 * container's limit. `ContainerInfo` carries no resources, so the number
 * stays the pod's; the sentence says whose it is.
 *
 * None for a plain init container: the pod's figure is what the running
 * containers may take, which leaves it out, so the sentence would quote a
 * limit that never applied to what was killed.
 */
function limitOf(pod: PodInfo, killed: ContainerInfo): string | null {
  if (killed.phase === "init") return null;
  const raw = pod.memoryLimits;
  if (!raw) return null;
  const bytes = Number(raw);
  return Number.isFinite(bytes) && bytes > 0 ? formatMemory(bytes) : raw;
}

export interface Address {
  host: string;
  port: number | null;
  /** The line it was read from, whole. */
  line: string;
  where: "sidecar" | "inCluster" | "outside";
  refused: boolean;
  timedOut: boolean;
  /**
   * The line said the connection failed and said neither how: `no route to
   * host`, `network is unreachable`. Reported as a refusal it claimed
   * something answered and said no — and the sentence then told the reader
   * a firewall would have timed out instead.
   */
  unclassified: boolean;
}

/** `host:port`, where the host is a name or a dotted address and the port is not a clock. */
const ADDRESS = /([a-z0-9][a-z0-9.-]*[a-z0-9]|[a-z0-9]):(\d{2,5})(?![:.]\d)/gi;

/**
 * Suffixes a peer never has. `main.py:42` and `handler.go:118` match the
 * address shape exactly, and taking the last match on the line made a
 * stack-trace frame the address the whole chain was read from.
 */
const NOT_A_HOST =
  /\.(py|go|js|ts|jsx|tsx|rs|java|rb|c|cc|cpp|h|hpp|php|cs|kt|scala|sh|yaml|yml|json|xml|sql|log|txt)$/i;
const FAILURE =
  /refused|ECONNREFUSED|timeout|timed out|ETIMEDOUT|unreachable|no route to host|EHOSTUNREACH/i;

function isHost(candidate: string): boolean {
  if (NOT_A_HOST.test(candidate)) return false;
  return candidate.includes(".") || /[a-z]/i.test(candidate);
}

/**
 * Where the address is, from the name alone.
 *
 * `namespaces` is what the app has seen of this cluster: `db.shop` is the
 * cross-namespace form every Kubernetes reader writes, and with two labels
 * and no `.svc` it was called outside the cluster — which then gated off
 * the Service lookup and added a NetworkPolicy line about a hop that never
 * leaves the cluster.
 */
function whereIs(
  host: string,
  namespaces: readonly string[] = []
): Address["where"] {
  const lower = host.toLowerCase();
  if (lower === "127.0.0.1" || lower === "localhost" || lower === "::1")
    return "sidecar";
  if (/^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(lower))
    return "inCluster";
  if (/\.svc(\.cluster\.local)?$/.test(lower) || !lower.includes("."))
    return "inCluster";
  const labels = lower.split(".");
  if (labels.length === 2 && namespaces.includes(labels[1])) return "inCluster";
  return "outside";
}

/**
 * A cluster-DNS host split into the Service name and the namespace it is in.
 *
 * `shop-db-rw.billing.svc.cluster.local` was matched on the bare name
 * against the pod's own namespace, so a same-named Service next door was
 * reported — with its endpoint count — as what stands behind an address in
 * a namespace nothing listed. An IP literal has neither part, and
 * `10.43.39.231` read as `name=10, namespace=43` matched nothing at all.
 */
export function namespaceOf(
  host: string,
  own: string
): { name: string; namespace: string; qualified: boolean } {
  const lower = host.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower))
    return { name: lower, namespace: own, qualified: false };
  const labels = lower.split(".");
  if (labels.length < 2 || labels[1] === "svc")
    return { name: labels[0], namespace: own, qualified: labels.length > 1 };
  return { name: labels[0], namespace: labels[1], qualified: true };
}

/**
 * The last address a failed connection named, in the lines given.
 *
 * `namespaces` narrows nothing; it only lets a two-label host be recognised
 * as the cross-namespace form rather than as something outside the cluster.
 */
export function addressIn(
  lines: readonly string[],
  namespaces: readonly string[] = []
): Address | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!FAILURE.test(line)) continue;
    const match = [...line.matchAll(ADDRESS)]
      .filter((found) => isHost(found[1]))
      .at(-1);
    if (!match) continue;
    const refused = /refused|ECONNREFUSED/i.test(line);
    const timedOut = /timeout|timed out|ETIMEDOUT/i.test(line);
    return {
      host: match[1],
      port: Number(match[2]),
      line: line.trim(),
      where: whereIs(match[1], namespaces),
      refused,
      timedOut,
      unclassified: !refused && !timedOut,
    };
  }
  return null;
}

/** What the app read behind the address, where it could. */
export interface Chain {
  address: Address | null;
  /**
   * Whether the Services of this namespace were read at all.
   *
   * Defaults to false, so a caller that forgets gets the honest answer:
   * `service: null` then means "could not look", not "no Service answers
   * to that address" — two sentences that send a reader to different
   * places, and the second one was printed for both.
   */
  servicesKnown: boolean;
  /** Whether the endpoints behind the Service answered. */
  endpointsKnown: boolean;
  /** The Service the address resolved to, and what stands behind it. */
  service: {
    name: string;
    namespace: string;
    /** `null` when the Service was found and its endpoints were not read. */
    ready: number | null;
    total: number | null;
  } | null;
  /** The container in this pod the address belongs to. */
  sidecar: ContainerInfo | null;
  /** What was asked for and refused or never read, in the reader's words. */
  notRead: string[];
}

export interface Check {
  says: HintSaying;
  /** Where to look: a place in the app, or nothing when the check is words. */
  to:
    /** A tab, and for the log tab the container the check is about. */
    | { kind: "tab"; tab: string; container?: string }
    | {
        kind: "object";
        objectKind: string;
        name: string;
        namespace: string | null;
      }
    | null;
}

export interface Hint {
  headline: HintSaying;
  lines: HintSaying[];
  checks: Check[];
}

/**
 * A container's state as a sentence the reader's language chooses, not an
 * English fragment dropped into a Russian one. The cluster's own word —
 * `CrashLoopBackOff`, `ContainerCreating` — is passed through untranslated,
 * which is the rule; "exited 137" was not.
 */
function stateWord(container: ContainerInfo): HintSaying {
  const state = container.state;
  if (state.type === "waiting")
    return state.reason
      ? { key: "stateWaitingReason", values: { reason: state.reason } }
      : { key: "stateWaiting" };
  if (state.type === "terminated")
    return {
      key: "stateExited",
      values: { code: state.termination.exitCode },
    };
  return { key: container.ready ? "stateRunning" : "stateRunningNotReady" };
}

/** The sentence and the checks for one trouble, from the chain the app read. */
export function hintFor(trouble: Trouble, pod: PodInfo, chain: Chain): Hint {
  const checks: Check[] = [];
  const lines: HintSaying[] = [];
  const objectCheck = (
    says: HintSaying,
    objectKind: string,
    name: string,
    namespace: string | null
  ) =>
    checks.push({ says, to: { kind: "object", objectKind, name, namespace } });

  switch (trouble.reason) {
    case "crashLoop": {
      const exit = trouble.exit;
      const address = chain.address;
      let headline: HintSaying = {
        key: "guessCrashLoop",
        values: {
          container: trouble.container,
          restarts: counted("countRestarts", trouble.restarts),
        },
      };
      if (address) {
        const at = { host: address.host, port: address.port ?? "" };
        if (address.where === "sidecar" && chain.sidecar) {
          headline = {
            key: "guessCrashRefusedSidecar",
            values: {
              ...at,
              sidecar: chain.sidecar.name,
              state: stateWord(chain.sidecar),
            },
          };
          checks.push({
            says: {
              key: "checkSidecarLines",
              values: { sidecar: chain.sidecar.name },
            },
            to: {
              kind: "tab",
              tab: "logs",
              container: chain.sidecar.name,
            },
          });
        } else if (address.where === "sidecar") {
          // Nothing in this pod claims the port. Falling through to the
          // outside arms announced that something outside the cluster
          // refused a connection to 127.0.0.1.
          headline = { key: "guessCrashLoopback", values: at };
        } else if (address.where === "inCluster" && chain.service) {
          const verb = address.timedOut ? "Timeout" : "Refused";
          headline =
            chain.service.ready === null
              ? {
                  key: "guessCrashServiceUncounted",
                  values: { ...at, service: chain.service.name },
                }
              : chain.service.ready === 0
                ? {
                    key: `guessCrash${verb}ServiceEmpty` as const,
                    values: { ...at, service: chain.service.name },
                  }
                : {
                    key: `guessCrash${verb}ServiceReady` as const,
                    values: {
                      ...at,
                      service: chain.service.name,
                      ready: chain.service.ready,
                      total: chain.service.total ?? 0,
                    },
                  };
          objectCheck(
            { key: "checkService", values: { service: chain.service.name } },
            "Service",
            chain.service.name,
            chain.service.namespace
          );
        } else if (address.where === "inCluster" && !chain.servicesKnown) {
          // The read failed. "No Service answers to it" is a claim about
          // the cluster; this is a claim about what the app could see.
          headline = { key: "guessCrashInClusterUnread", values: at };
        } else if (address.where === "inCluster") {
          headline = { key: "guessCrashInClusterUnknown", values: at };
        } else if (address.timedOut) {
          headline = { key: "guessCrashTimeoutOutside", values: at };
        } else if (address.unclassified) {
          // `no route to host` is neither. Called a refusal it claimed
          // something answered and said no.
          headline = { key: "guessCrashUnreachableOutside", values: at };
        } else {
          headline = { key: "guessCrashRefusedOutside", values: at };
        }
        lines.push({ key: "factLastLineSaid", values: { line: address.line } });
      }
      if (exit) {
        lines.push({
          key: "factExited",
          values: {
            container: trouble.container,
            code: exit.exitCode,
            restarts: counted("countRestarts", trouble.restarts),
          },
        });
      }
      checks.push({
        says: {
          key: "checkLastLines",
          values: { container: trouble.container },
        },
        to: { kind: "tab", tab: "logs", container: trouble.container },
      });
      for (const volume of pod.volumes) {
        for (const ref of volume.refs) {
          if (ref.kind === "ConfigMap" || ref.kind === "Secret") {
            objectCheck(
              {
                key: "checkConfig",
                values: { kind: ref.kind, name: ref.name },
              },
              ref.kind,
              ref.name,
              pod.namespace
            );
          }
        }
      }
      return { headline, lines, checks };
    }
    case "oomKilled":
      lines.push({
        key: "factRestarts",
        values: {
          container: trouble.container,
          times: counted("countTimes", trouble.restarts),
        },
      });
      checks.push({
        says: { key: "checkLimits" },
        to: { kind: "tab", tab: "containers" },
      });
      if (pod.nodeName) {
        objectCheck(
          { key: "checkNode", values: { node: pod.nodeName } },
          "Node",
          pod.nodeName,
          null
        );
      }
      return {
        headline: trouble.limit
          ? {
              // Said as the pod's total, because that is what it is:
              // `ContainerInfo` carries no resources, so this container's
              // own limit is not knowable here.
              key: "guessOomWithLimit",
              values: { container: trouble.container, limit: trouble.limit },
            }
          : { key: "guessOom", values: { container: trouble.container } },
        lines,
        checks,
      };
    case "imagePull":
      if (trouble.message)
        lines.push({
          key: "factKubeletSaid",
          values: { message: trouble.message },
        });
      checks.push({
        says: { key: "checkImageRef", values: { image: trouble.image } },
        to: { kind: "tab", tab: "containers" },
      });
      // Not "a pull secret": a mounted Secret is a Secret the pod reads,
      // and `imagePullSecrets` is a different field this app does not carry
      // on `PodInfo`. Calling every mounted Secret a pull secret sent the
      // reader to edit the wrong object.
      for (const volume of pod.volumes) {
        for (const ref of volume.refs) {
          if (ref.kind === "Secret")
            objectCheck(
              { key: "checkMountedSecret", values: { name: ref.name } },
              "Secret",
              ref.name,
              pod.namespace
            );
        }
      }
      return {
        headline: { key: "guessImagePull", values: { image: trouble.image } },
        lines,
        checks,
      };
    case "failedMount":
      if (trouble.message)
        lines.push({
          key: "factKubeletSaid",
          values: { message: trouble.message },
        });
      for (const volume of pod.volumes) {
        if (trouble.volume && volume.name !== trouble.volume) continue;
        for (const ref of volume.refs) {
          objectCheck(
            {
              key: "checkVolumeRef",
              values: { kind: ref.kind, name: ref.name },
            },
            ref.kind,
            ref.name,
            pod.namespace
          );
        }
      }
      return {
        headline: {
          key: "guessFailedMount",
          values: {
            volume: trouble.volume ? ` ${trouble.volume}` : "",
            attempts: counted("countAttempts", trouble.count),
          },
        },
        lines,
        checks,
      };
    case "pending":
      if (trouble.message)
        lines.push({
          key: "factSchedulerSaid",
          values: { message: trouble.message },
        });
      checks.push({
        says: { key: "checkRequests" },
        to: { kind: "tab", tab: "containers" },
      });
      checks.push({
        says: { key: "checkNodes" },
        to: { kind: "object", objectKind: "Node", name: "", namespace: null },
      });
      return {
        headline: {
          key: trouble.sameEachTime ? "guessPendingSame" : "guessPendingVaried",
          values: trouble.sameEachTime
            ? { times: counted("countTimes", trouble.count) }
            : { attempts: counted("countAttempts", trouble.count) },
        },
        lines,
        checks,
      };
    case "probeFailed": {
      if (trouble.message)
        lines.push({
          key: "factKubeletSaid",
          values: { message: trouble.message },
        });
      checks.push({
        says: { key: "checkProbe" },
        to: { kind: "tab", tab: "containers" },
      });
      // An Unhealthy event carries no container, and `EventInfo` has no
      // fieldPath to read one from. A pod with one container answers it;
      // anything else is a name the app does not have, and the literal
      // "app" was a container many pods do not even run.
      const only = pod.containers.length === 1 ? pod.containers[0].name : null;
      const named = trouble.container ?? only;
      checks.push({
        says: named
          ? { key: "checkLastLines", values: { container: named } }
          : { key: "checkLastLinesUnnamed" },
        to: {
          kind: "tab",
          tab: "logs",
          ...(named ? { container: named } : {}),
        },
      });
      return {
        headline: {
          // The kubelet writes "Readiness probe failed" and the like; where
          // it did not, the app does not know which probe it was.
          key: trouble.probe ? "guessProbe" : "guessProbeUnnamed",
          values: {
            ...(trouble.probe ? { probe: trouble.probe } : {}),
            times: counted("countTimes", trouble.count),
          },
        },
        lines,
        checks,
      };
    }
  }
}

/**
 * What a line may not carry off this machine.
 *
 * The credential is almost always in the same line as the address: a DSN, a
 * JDBC URL, a bearer token a client echoed. Nothing here can be complete —
 * a log line is arbitrary text — so this removes the shapes a secret takes
 * rather than pretending to recognise secrets, and the copy beside it says
 * so instead of promising.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  // scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1…:…@"],
  // password=…, token: …, api_key=…, secret=…, in query strings or logfmt
  [
    /\b(pass(?:word|wd)?|pwd|token|secret|api[-_]?key|access[-_]?key|auth)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;)"']+)/gi,
    "$1$2…",
  ],
  // Authorization: Bearer …, and a bare JWT
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …"],
  [/\beyJ[A-Za-z0-9._-]{16,}/g, "…"],
];

/**
 * A line with the shapes a secret takes taken out. Applied to everything
 * this app hands to somebody else — the search engine and the clipboard.
 */
export function redact(line: string): string {
  let out = line;
  for (const [pattern, replacement] of SECRET_SHAPES)
    out = out.replace(pattern, replacement);
  return out;
}

export type SearchEngine = "google" | "duckduckgo" | "custom";

/** What a search engine is asked, with the names that belong to this cluster taken out. */
export function searchQuery(
  trouble: Trouble,
  pod: PodInfo,
  address: Address | null,
  strip: boolean
): string {
  const parts: string[] = ["kubernetes"];
  switch (trouble.reason) {
    case "crashLoop":
      parts.push("CrashLoopBackOff");
      if (trouble.exit) parts.push(`exit code ${trouble.exit.exitCode}`);
      // Not the raw line: what the app recognised in it. The line is
      // arbitrary text from the container, and the query goes to a search
      // engine — a DSN with a password in it would go with it.
      if (address)
        parts.push(
          address.refused
            ? "connection refused"
            : address.timedOut
              ? "i/o timeout"
              : "connection failed"
        );
      break;
    case "oomKilled":
      parts.push("OOMKilled container restart");
      break;
    case "imagePull":
      parts.push("ImagePullBackOff", trouble.message ?? "");
      break;
    case "failedMount":
      parts.push("FailedMount", trouble.message ?? "");
      break;
    case "pending":
      parts.push("FailedScheduling", trouble.message ?? "");
      break;
    case "probeFailed":
      parts.push(
        `${trouble.probe ?? "readiness"} probe failed`,
        trouble.message ?? ""
      );
      break;
  }
  // Whatever the switch says, the shapes a secret takes never go out.
  let query = redact(parts.filter(Boolean).join(" "))
    .replace(/\s+/g, " ")
    .trim();
  if (strip) {
    // Shapes before names: a name replaced first breaks the shape around
    // it. `shop` taken out of `db.shop.svc.cluster.local` left
    // `db.….svc.cluster.local`, which the cluster-DNS rule could no longer
    // match, so the rest of the address went out anyway.
    query = query
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "…")
      // IPv6, which the rule above cannot see at all.
      .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, "…")
      .replace(/[a-z0-9-]+(\.[a-z0-9-]+)*\.svc(\.cluster\.local)?\b/gi, "…");
    // Longest first: `shop` replaced before `shop-db` leaves `…-db`, and
    // the longer name then matches nothing and survives.
    const names = [
      pod.name,
      pod.namespace,
      ...pod.containers.map((c) => c.image),
      ...pod.initContainers.map((c) => c.image),
      pod.nodeName ?? "",
      address?.host ?? "",
    ]
      .filter((name) => name.length > 2)
      .sort((a, b) => b.length - a.length);
    for (const name of names) query = query.split(name).join("…");
    query = query.replace(/"[^"]*…[^"]*"/g, "…");
  }
  // Sliced by code point, so a cut never leaves half a surrogate pair for
  // `encodeURIComponent` to throw on.
  return [...query].slice(0, 300).join("");
}

export const UTM = "utm_source=rubick.tech";

export function searchUrl(
  engine: SearchEngine,
  custom: string,
  query: string
): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${q}&${UTM}`;
    case "duckduckgo":
      return `https://duckduckgo.com/?q=${q}&${UTM}`;
    case "custom": {
      const url = custom.includes("{q}")
        ? custom.replace("{q}", q)
        : `${custom}${custom.includes("?") ? "&" : "?"}q=${q}`;
      return url;
    }
  }
}

/** A ConfigMap or Secret the pod mounts: the name and the keys, never a value. */
export interface MountedConfig {
  kind: string;
  name: string;
  path: string;
  keys: number | null;
}

export interface AgentReportInput {
  version: string;
  context: string;
  at: string;
  pod: PodInfo;
  trouble: Trouble | null;
  /** The last lines of the troubled container; empty when not read or not wanted. */
  logLines: string[];
  logContainer: string | null;
  logPrevious: boolean;
  events: EventInfo[];
  chain: Chain;
  mounts: MountedConfig[];
  /** The app's own sentence, in the reader's language, labelled as a guess. */
  guess: string | null;
}

function foldEvents(events: EventInfo[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event.reason ?? "?";
    counts.set(key, (counts.get(key) ?? 0) + occurrences(event));
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} x${n}`)
    .join(" · ");
}

/**
 * Plain text for a chat or an agent: what the app read, what it did not,
 * and its guess labelled as one.
 *
 * A mount is a name and a key count — no Secret's data is ever read. The
 * log lines are a different matter: they are whatever the container
 * printed, and a framework echoing its resolved configuration prints a
 * password. {@link redact} takes out the shapes a secret takes, and the
 * copy beside the button says the lines are the container's own words
 * rather than promising they are clean.
 */
export function agentReport(input: AgentReportInput): string {
  const { pod } = input;
  const owner =
    pod.ownerReferences.find((o) => o.controller) ?? pod.ownerReferences[0];
  const out: string[] = [];
  out.push(
    `# Rubick ${input.version} · context ${input.context} · ${input.at}`
  );
  out.push(
    `Pod ${pod.namespace}/${pod.name} · ${pod.status.display}` +
      (owner ? ` · owner ${owner.kind} ${owner.name}` : "") +
      (pod.nodeName ? ` · node ${pod.nodeName}` : "")
  );
  out.push("");
  for (const container of [...pod.initContainers, ...pod.containers]) {
    const state = container.state;
    const word =
      state.type === "waiting"
        ? `waiting, reason ${state.reason ?? "?"}`
        : state.type === "terminated"
          ? `terminated, exit ${state.termination.exitCode}${state.termination.reason ? ` (${state.termination.reason})` : ""}`
          : state.type === "running"
            ? container.ready
              ? "running, ready"
              : "running, not ready"
            : "unknown";
    out.push(`Container ${container.name}: ${word}`);
    out.push(`  image ${container.image}`);
    if (container.lastTerminated) {
      const exit = container.lastTerminated;
      out.push(
        `  last exit: code ${exit.exitCode}${exit.reason ? ` ${exit.reason}` : ""}${exit.finishedAt ? `, ${exit.finishedAt}` : ""} · restarts ${container.restartCount}`
      );
    }
  }
  if (input.logLines.length > 0) {
    out.push("");
    out.push(
      `Last ${input.logLines.length} log lines (container ${input.logContainer ?? "?"}${input.logPrevious ? ", previous run" : ""}):`
    );
    for (const line of input.logLines) out.push(`  ${redact(line)}`);
  }
  if (input.events.length > 0) {
    out.push("");
    out.push(`Events (folded): ${foldEvents(input.events)}`);
  }
  const chain = input.chain;
  if (chain.address || chain.service || input.mounts.length > 0) {
    out.push("");
    out.push("What the app read:");
    if (chain.address)
      out.push(
        `  address ${chain.address.host}:${chain.address.port ?? "?"} named in the log, ${chain.address.where === "sidecar" ? "this pod itself" : chain.address.where === "inCluster" ? "inside the cluster" : "outside the cluster"}${chain.address.refused ? ", refused" : chain.address.timedOut ? ", timed out" : ""}`
      );
    if (chain.service)
      out.push(
        `  Service ${chain.service.namespace}/${chain.service.name}: ${chain.service.ready} of ${chain.service.total} endpoints ready`
      );
    if (chain.sidecar)
      out.push(`  sidecar ${chain.sidecar.name}: ${stateWord(chain.sidecar)}`);
    for (const mount of input.mounts)
      out.push(
        `  ${mount.kind} ${mount.name} mounted at ${mount.path}${mount.keys !== null ? ` (${mount.keys} keys, values not included)` : " (values not included)"}`
      );
  }
  out.push("");
  out.push(
    `Not read: ${chain.notRead.length > 0 ? chain.notRead.join("; ") : "nothing the app asked for was refused"}`
  );
  if (input.guess) {
    out.push(`App's own guess: ${input.guess}`);
  }
  return out.join("\n");
}
