import type {
  EndedRun,
  Evidence,
  PodCause,
  ProbeCheck,
  PullFailure,
  SetupWarning,
  SharedCause,
  Unfit,
  Warned,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { listWords } from "@/i18n/say";
import { formatAge, formatDuration } from "@/lib/utils";

/**
 * Why a pod is red or amber, in the words every surface that draws it says.
 *
 * The cause itself is decided once, in Rust (`pod_cause`), from the pod's
 * own status; this only phrases it, with whatever evidence the surface read
 * beside it. A sentence that goes past the evidence says so.
 */

export type CauseTone = "err" | "warn";

export interface CauseWords {
  /** What happened, and how long it took, as one sentence. */
  sentence: string;
  /** The app's or the cluster's own words, quoted, and what they are. */
  quote: { label: string; text: string } | null;
  /** What could not be read, said as such. */
  note: string | null;
  tone: CauseTone;
}

/** A cause still true at `now`: an exit a container has been up since stops counting at its `until`. */
export function currentCause(
  cause: PodCause | null | undefined,
  now: number = Date.now()
): PodCause | null {
  if (!cause) return null;
  if (cause.says === "exits" && cause.until && Date.parse(cause.until) <= now)
    return null;
  return cause;
}

/** A cause past the first moments of a start, in which every probe has yet to pass. */
export function countsAt(
  cause: PodCause | null,
  now: number = Date.now()
): PodCause | null {
  if (
    cause?.says === "notReady" &&
    cause.countsFrom &&
    Date.parse(cause.countsFrom) > now
  )
    return null;
  return cause;
}

/** A pod being set up, where its kubelet's warnings were read and there are some. */
export function kubeletWarned(cause: PodCause | null): PodCause | null {
  return cause?.says === "creating" &&
    cause.kubelet.says === "read" &&
    cause.kubelet.warnings.length > 0
    ? cause
    : null;
}

/** Whether the kubelet's warnings already name the object `volume` cannot mount, leaving nothing to guess. */
export function mountSettled(
  cause: PodCause | null,
  volume: string | null
): boolean {
  return (
    cause?.says === "creating" &&
    cause.kubelet.says === "read" &&
    cause.kubelet.warnings.some(
      ({ fault }) =>
        fault.says === "missing" &&
        (volume === null || fault.volume === null || fault.volume === volume)
    )
  );
}

/** How long a run lasted, where the kubelet stamped both ends. */
export function ranSeconds(run: EndedRun): number | null {
  if (!run.started || !run.ended) return null;
  const ran = (Date.parse(run.ended) - Date.parse(run.started)) / 1000;
  return Number.isFinite(ran) && ran >= 0 ? ran : null;
}

const ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g"
);

/** Lines that carry no reason of their own: frames, the runtime's sign-off, a wrapper's exit note. */
const NOT_TELLING =
  /^(goroutine \d+|Node\.js v\d|exit status \d+$|\.\.\. \d+ more|[\w.$/*<>-]+\([^)]*\)$)/;

/**
 * The line of a run's last words that says why: the last one that is not a
 * stack frame or a sign-off, and whether it is also the very last line.
 */
export function tellingLine(
  text: string
): { text: string; last: boolean } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(ESCAPE, "").trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const end = lines.length - 1;
  for (let at = end; at >= 0; at -= 1) {
    const line = lines[at];
    if (!/^\s/.test(line) && !NOT_TELLING.test(line.trim()))
      return { text: line.trim(), last: at === end };
  }
  return { text: lines[end].trim(), last: true };
}

function howItEnded(run: EndedRun): string {
  const code =
    run.signal !== null ? `signal ${run.signal}` : `exit ${run.code}`;
  return run.reason ? `${code}, ${run.reason}` : code;
}

function logNote(log: Evidence, t: T): string | null {
  switch (log.says) {
    case "reading":
      return t("readings", "failedRunLogAsking");
    case "nothing":
      return t("readings", "failedRunLogEmpty");
    case "gone":
      return t("readings", "failedRunLogGone");
    case "refused":
      return t("cause", "logRefused");
    case "failed":
      return t("cause", "logFailed", { said: log.said });
    case "line":
    case "notRead":
      return null;
  }
}

function quoteOf(run: EndedRun, t: T): CauseWords["quote"] {
  const said = run.said ? tellingLine(run.said) : null;
  if (said) return { label: t("cause", "exitMessage"), text: said.text };
  if (run.log.says !== "line") return null;
  return {
    label: t("cause", run.log.last ? "lastLine" : "loggedLine"),
    text: run.log.text,
  };
}

/** What an exit means where its code or signal has a standard meaning, or null for the app's own. */
export function exitMeaning(run: EndedRun, t: T): string | null {
  if (run.reason === "OOMKilled")
    return run.limit
      ? t("cause", "meansOomLimit", { limit: run.limit })
      : t("cause", "meansOomNoLimit");
  if (run.reason === "StartError") return t("cause", "meansStartError");
  const signal = run.signal ?? (run.code > 128 ? run.code - 128 : null);
  if (run.code === 0 && signal === null) return t("cause", "meansClean");
  if (run.code === 126) return t("cause", "meansNotExecutable");
  if (run.code === 127) return t("cause", "meansNotFound");
  switch (signal) {
    case 9:
      return t("cause", "meansKilled");
    case 15:
      return t("cause", "meansTerminated");
    case 11:
      return t("cause", "meansSegfault");
    case 6:
      return t("cause", "meansAborted");
    case null:
      return null;
    default:
      return t("cause", "meansSignal", { signal });
  }
}

/** What a readiness probe asks, in the form kubectl describe prints it. */
export function probeText(probe: ProbeCheck): string {
  switch (probe.says) {
    case "http":
      return `${probe.scheme === "HTTPS" ? "HTTPS " : ""}GET ${probe.path} on port ${probe.port}`;
    case "tcp":
      return `TCP port ${probe.port}`;
    case "grpc":
      return `gRPC port ${probe.port}`;
    case "exec":
      return probe.command.join(" ");
  }
}

function notReadyWords(
  cause: Extract<PodCause, { says: "notReady" }>,
  t: T
): CauseWords {
  const containers = listWords(cause.containers, t);
  const sentence = cause.since
    ? t("cause", "notReadyFor", { containers, age: formatAge(cause.since, t) })
    : t("cause", "notReady", { containers });
  return {
    sentence,
    quote: cause.probe
      ? { label: t("cause", "readinessProbe"), text: probeText(cause.probe) }
      : null,
    note: cause.probe ? null : t("cause", "noReadinessProbe"),
    tone: "warn",
  };
}

const PULL_SAYING = {
  notFound: "pullNotFound",
  denied: "pullDenied",
  rateLimited: "pullRateLimited",
  unreachable: "pullUnreachable",
  backingOff: "pullBackingOff",
  other: "pullOther",
} as const satisfies Record<PullFailure, string>;

const BLOCKED_SAYING: Record<string, keyof typeof en.cause> = {
  InvalidImageName: "invalidImage",
  CreateContainerConfigError: "configError",
  CreateContainerError: "createError",
  RunContainerError: "runError",
};

function blockedWords(
  cause: Extract<PodCause, { says: "blocked" }>,
  t: T
): CauseWords {
  const { container, image, reason, said, pull, secrets } = cause;
  const sentence = t(
    "cause",
    pull ? PULL_SAYING[pull] : (BLOCKED_SAYING[reason] ?? "blockedOther"),
    { container, image, reason }
  );
  const note =
    pull === "denied"
      ? secrets.length > 0
        ? t("cause", "pullSecretsNamed", { secrets: secrets.join(", ") })
        : t("cause", "pullSecretsNone")
      : pull === "backingOff"
        ? t("cause", "pullBackingOffNote")
        : null;
  return {
    sentence,
    quote: said ? { label: t("cause", "kubeletSaid"), text: said } : null,
    note,
    tone: "err",
  };
}

/** One reason the scheduler gave, as a clause over the nodes it covers. */
export function unfitWords(unfit: Unfit, t: T): string {
  switch (unfit.says) {
    case "short":
      return t("cause", "unfitShort", {
        n: unfit.nodes,
        resource: unfit.resource,
      });
    case "taint":
      return t("cause", "unfitTaint", { n: unfit.nodes, taint: unfit.taint });
    case "selector":
      return t("cause", "unfitSelector", { n: unfit.nodes });
    case "podAffinity":
      return t("cause", "unfitPodAffinity", { n: unfit.nodes });
    case "cordoned":
      return t("cause", "unfitCordoned", { n: unfit.nodes });
    case "tooManyPods":
      return t("cause", "unfitTooManyPods", { n: unfit.nodes });
    case "volumeZone":
      return t("cause", "unfitVolumeZone", { n: unfit.nodes });
    case "topology":
      return t("cause", "unfitTopology", { n: unfit.nodes });
    case "topologyUnlabelled":
      return unfit.keys.length === 1
        ? t("cause", "unfitTopologyUnlabelled", {
            n: unfit.nodes,
            key: unfit.keys[0],
          })
        : unfit.keys.length === 0
          ? t("cause", "unfitTopologyUnlabelledUnnamed", { n: unfit.nodes })
          : t("cause", "unfitTopologyUnlabelledOneOf", {
              n: unfit.nodes,
              keys: unfit.keys.join(", "),
            });
    case "claimsUnbound":
      return t("cause", "unfitClaimsUnbound");
    case "other":
      return unfit.nodes === null
        ? unfit.text
        : t("cause", "unfitOther", { n: unfit.nodes, text: unfit.text });
  }
}

function unplacedWords(
  cause: Extract<PodCause, { says: "unplaced" }>,
  t: T
): CauseWords {
  const reasons = cause.why.map((unfit) => unfitWords(unfit, t));
  const since = cause.since ? formatAge(cause.since, t) : null;
  const head =
    cause.nodes !== null && reasons.length > 0
      ? t("cause", "unplacedOf", { n: cause.nodes })
      : t("cause", "unplaced");
  return {
    sentence: [head, reasons.join("; ")].filter(Boolean).join(": "),
    quote: cause.said
      ? { label: t("cause", "schedulerSaid"), text: cause.said }
      : null,
    note: since ? t("cause", "unplacedFor", { age: since }) : null,
    tone: "err",
  };
}

/** The objects missing volumes mount, each once, as kubectl names them. */
function missingObjects(warnings: SetupWarning[]): string[] {
  const named = warnings.flatMap(({ fault }) =>
    fault.says === "missing" ? [`${fault.kind} ${fault.name}`] : []
  );
  return [...new Set(named)];
}

/** What the kubelet's warnings come to: the missing objects first, then the sandbox, a volume, anything else. */
function setupSentence(
  warnings: SetupWarning[],
  t: T
): { sentence: string; quoted: SetupWarning } | null {
  const missing = missingObjects(warnings);
  const first = (says: SetupWarning["fault"]["says"]) =>
    warnings.find((warning) => warning.fault.says === says);
  if (missing.length > 0)
    return {
      sentence: t("cause", "creatingMissing", {
        n: missing.length,
        objects: listWords(missing, t),
      }),
      quoted: first("missing")!,
    };
  const sandbox = first("sandbox");
  if (sandbox)
    return { sentence: t("cause", "creatingSandbox"), quoted: sandbox };
  const volume = first("volume");
  if (volume?.fault.says === "volume")
    return {
      sentence: volume.fault.volume
        ? t("cause", "creatingVolume", { volume: volume.fault.volume })
        : t("cause", "creatingVolumes"),
      quoted: volume,
    };
  const other = warnings[0];
  return other
    ? {
        sentence: t("cause", "creatingOther", { reason: other.reason }),
        quoted: other,
      }
    : null;
}

function warnedNote(
  kubelet: Warned,
  sandbox: boolean | null,
  t: T
): string | null {
  switch (kubelet.says) {
    case "notRead":
      return t("cause", "creatingAsk");
    case "reading":
      return t("cause", "creatingReading");
    case "refused":
      return t("cause", "creatingRefused");
    case "failed":
      return t("cause", "creatingFailed", { said: kubelet.said });
    case "read":
      return t(
        "cause",
        sandbox === false ? "creatingQuiet" : "creatingQuietUnknown"
      );
  }
}

function creatingWords(
  cause: Extract<PodCause, { says: "creating" }>,
  t: T
): CauseWords {
  const told =
    cause.kubelet.says === "read"
      ? setupSentence(cause.kubelet.warnings, t)
      : null;
  if (told)
    return {
      sentence: told.sentence,
      quote: {
        label: t("cause", "kubeletSaid"),
        text: `${told.quoted.reason}: ${told.quoted.said}`,
      },
      note: null,
      tone: "err",
    };
  return {
    sentence: cause.since
      ? t("cause", "creatingFor", { age: formatAge(cause.since, t) })
      : t("cause", "creating"),
    quote: null,
    note: warnedNote(cause.kubelet, cause.sandbox, t),
    tone: "warn",
  };
}

/** The cause in words. */
export function causeWords(cause: PodCause, t: T): CauseWords {
  if (cause.says === "creating") return creatingWords(cause, t);
  if (cause.says === "unplaced") return unplacedWords(cause, t);
  if (cause.says === "notReady") return notReadyWords(cause, t);
  if (cause.says === "blocked") return blockedWords(cause, t);
  const { container, run } = cause;
  if (!run)
    return {
      sentence: t("cause", "restartedUnreported", { container }),
      quote: null,
      note: null,
      tone: "warn",
    };
  const ran = ranSeconds(run);
  const exited = t("cause", "exited", { container, how: howItEnded(run) });
  const meaning = exitMeaning(run, t);
  const head = meaning ? `${exited}: ${meaning}` : exited;
  return {
    sentence:
      ran === null
        ? head
        : `${head}, ${t("cause", "ranFor", { ran: formatDuration(ran) })}`,
    quote: quoteOf(run, t),
    note: run.said ? null : logNote(run.log, t),
    tone: "err",
  };
}

/** The evidence after the sentence, as plain text. */
export function evidenceText(words: CauseWords): string {
  return [words.quote && `${words.quote.label} ${words.quote.text}`, words.note]
    .filter(Boolean)
    .join(" ");
}

/** The cause as plain text: a tooltip, a row's hover, a line in a shared file. */
export function causeText(cause: PodCause, t: T): string {
  const words = causeWords(cause, t);
  return [`${words.sentence}.`, evidenceText(words)].filter(Boolean).join(" ");
}

/** "2 of 3 pods:", the share of a workload's pods its cause is told from. */
export function podsShare(pods: number, of: number, t: T): string {
  return t("readings", "podsShareCause", { pods, n: of });
}

/** A shared cause as plain text: how many pods share it, then the cause. */
export function sharedText(shared: SharedCause, t: T): string {
  return `${podsShare(shared.pods, shared.of, t)} ${causeText(shared.cause, t)}`;
}

/** How many pods share it, unless the words before it already counted every one of `counted`. */
export function shareAfterCount(
  shared: SharedCause,
  counted: number,
  t: T
): string | null {
  return shared.pods === counted && shared.of === counted
    ? null
    : podsShare(shared.pods, shared.of, t);
}

/** {@link sharedText} after words that already counted `counted` pods. */
export function sharedAfterCount(
  shared: SharedCause,
  counted: number,
  t: T
): string {
  const share = shareAfterCount(shared, counted, t);
  return `${share ? `${share} ` : ""}${causeText(shared.cause, t)}`;
}

/** Two pods share a cause when it is the same mechanism in the same container. */
function causeKey(cause: PodCause): string {
  switch (cause.says) {
    case "exits":
      return JSON.stringify([
        cause.says,
        cause.container,
        cause.run && [cause.run.code, cause.run.reason],
      ]);
    case "blocked":
      return JSON.stringify([
        cause.says,
        cause.container,
        cause.reason,
        cause.pull,
      ]);
    case "notReady":
      return JSON.stringify([cause.says, cause.containers]);
    case "unplaced":
      return JSON.stringify([
        cause.says,
        cause.why.map((unfit) =>
          JSON.stringify(unfit, Object.keys(unfit).sort())
        ),
      ]);
    case "creating":
      return cause.says;
  }
}

/** Whether two pods' causes are the one `sharedCause` would count together. */
export const sameCause = (a: PodCause, b: PodCause): boolean =>
  causeKey(a) === causeKey(b);

/**
 * The cause most of a workload's pods share, how many share it and how many
 * it runs. `share` in pod_cause.rs answers the Overview and a Deployment's
 * read; src/contracts/shared-cause-conformance.json holds both to one answer.
 */
export function sharedCause(
  pods: readonly { gone?: boolean; cause?: PodCause | null }[]
): SharedCause | null {
  let of = 0;
  const groups = new Map<string, { cause: PodCause; pods: number }>();
  for (const { gone, cause } of pods) {
    if (gone) continue;
    of += 1;
    if (!cause) continue;
    const key = causeKey(cause);
    const group = groups.get(key) ?? { cause, pods: 0 };
    group.pods += 1;
    groups.set(key, group);
  }
  let told: { cause: PodCause; pods: number } | null = null;
  for (const group of groups.values())
    if (!told || group.pods >= told.pods) told = group;
  return told && { cause: told.cause, pods: told.pods, of };
}
