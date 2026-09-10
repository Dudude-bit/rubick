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

export type HintKey = keyof typeof en.hints;

export interface HintSaying {
  key: HintKey;
  values?: Record<string, string | number>;
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
  const oom = all.find(
    (c) =>
      c.lastTerminated?.reason === "OOMKilled" &&
      (c.restartCount > 0 || c.state.type !== "running")
  );
  if (oom) {
    return {
      reason: "oomKilled",
      container: oom.name,
      limit: pod.memoryLimits,
      restarts: oom.restartCount,
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
  const mount =
    latest(events, "FailedMount") ?? latest(events, "FailedAttachVolume");
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

export interface Address {
  host: string;
  port: number | null;
  /** The line it was read from, whole. */
  line: string;
  where: "sidecar" | "inCluster" | "outside";
  refused: boolean;
  timedOut: boolean;
}

/** `host:port`, where the host is a name or a dotted address and the port is not a clock. */
const ADDRESS = /([a-z0-9][a-z0-9.-]*[a-z0-9]|[a-z0-9]):(\d{2,5})(?![:.]\d)/gi;
const FAILURE =
  /refused|ECONNREFUSED|timeout|timed out|ETIMEDOUT|unreachable|no route to host|EHOSTUNREACH/i;

function isHost(candidate: string): boolean {
  return candidate.includes(".") || /[a-z]/i.test(candidate);
}

function whereIs(host: string): Address["where"] {
  const lower = host.toLowerCase();
  if (lower === "127.0.0.1" || lower === "localhost" || lower === "::1")
    return "sidecar";
  if (/^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(lower))
    return "inCluster";
  if (/\.svc(\.cluster\.local)?$/.test(lower) || !lower.includes("."))
    return "inCluster";
  return "outside";
}

/** The last address a failed connection named, in the lines given. */
export function addressIn(lines: readonly string[]): Address | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!FAILURE.test(line)) continue;
    const match = [...line.matchAll(ADDRESS)]
      .filter((found) => isHost(found[1]))
      .at(-1);
    if (!match) continue;
    return {
      host: match[1],
      port: Number(match[2]),
      line: line.trim(),
      where: whereIs(match[1]),
      refused: /refused|ECONNREFUSED/i.test(line),
      timedOut: /timeout|timed out|ETIMEDOUT/i.test(line),
    };
  }
  return null;
}

/** What the app read behind the address, where it could. */
export interface Chain {
  address: Address | null;
  /** The Service the address resolved to, and what stands behind it. */
  service: {
    name: string;
    namespace: string;
    ready: number;
    total: number;
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
    | { kind: "tab"; tab: string }
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

function stateWord(container: ContainerInfo): string {
  const state = container.state;
  if (state.type === "waiting") return state.reason ?? "waiting";
  if (state.type === "terminated")
    return `exited ${state.termination.exitCode}`;
  return container.ready ? "running" : "running, not ready";
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
        values: { container: trouble.container, n: trouble.restarts },
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
            to: { kind: "tab", tab: "logs" },
          });
        } else if (address.where === "inCluster" && chain.service) {
          headline =
            chain.service.ready === 0
              ? {
                  key: "guessCrashRefusedServiceEmpty",
                  values: { ...at, service: chain.service.name },
                }
              : {
                  key: "guessCrashRefusedServiceReady",
                  values: {
                    ...at,
                    service: chain.service.name,
                    ready: chain.service.ready,
                    total: chain.service.total,
                  },
                };
          objectCheck(
            { key: "checkService", values: { service: chain.service.name } },
            "Service",
            chain.service.name,
            chain.service.namespace
          );
        } else if (address.where === "inCluster") {
          headline = { key: "guessCrashInClusterUnknown", values: at };
        } else if (address.timedOut) {
          headline = { key: "guessCrashTimeoutOutside", values: at };
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
            n: trouble.restarts,
          },
        });
      }
      checks.push({
        says: {
          key: "checkLastLines",
          values: { container: trouble.container },
        },
        to: { kind: "tab", tab: "logs" },
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
        values: { container: trouble.container, n: trouble.restarts },
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
        headline: {
          key: "guessOom",
          values: {
            container: trouble.container,
            limit: trouble.limit ? ` (${trouble.limit})` : "",
          },
        },
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
      for (const volume of pod.volumes) {
        for (const ref of volume.refs) {
          if (ref.kind === "Secret")
            objectCheck(
              { key: "checkPullSecret", values: { name: ref.name } },
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
            n: trouble.count,
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
          values: { n: trouble.count },
        },
        lines,
        checks,
      };
    case "probeFailed":
      if (trouble.message)
        lines.push({
          key: "factKubeletSaid",
          values: { message: trouble.message },
        });
      checks.push({
        says: { key: "checkProbe" },
        to: { kind: "tab", tab: "containers" },
      });
      checks.push({
        says: {
          key: "checkLastLines",
          values: { container: trouble.container ?? "app" },
        },
        to: { kind: "tab", tab: "logs" },
      });
      return {
        headline: {
          key: "guessProbe",
          values: { probe: trouble.probe ?? "readiness", n: trouble.count },
        },
        lines,
        checks,
      };
  }
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
      if (address) parts.push(address.line);
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
  let query = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (strip) {
    const names = [
      pod.name,
      pod.namespace,
      ...pod.containers.map((c) => c.image),
      ...pod.initContainers.map((c) => c.image),
      pod.nodeName ?? "",
      address?.host ?? "",
    ].filter((name) => name.length > 2);
    for (const name of names) query = query.split(name).join("…");
    query = query
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "…")
      .replace(/\b[a-z0-9-]+\.[a-z0-9.-]+\.svc(\.cluster\.local)?\b/gi, "…")
      .replace(/"[^"]*…[^"]*"/g, "…");
  }
  return query.slice(0, 300);
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
 * and its guess labelled as one. Secret values cannot get in because
 * nothing here accepts them; a mount is a name and a key count.
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
    for (const line of input.logLines) out.push(`  ${line}`);
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
