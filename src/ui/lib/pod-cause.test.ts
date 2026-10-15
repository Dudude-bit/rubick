import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { EndedRun, PodCause, SetupWarning } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  causeText,
  causeWords,
  currentCause,
  exitMeaning,
  sharedCause,
  tellingLine,
} from "@/lib/pod-cause";

const t: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

function run(over: Partial<EndedRun> = {}): EndedRun {
  return {
    code: 1,
    signal: null,
    reason: "Error",
    started: "2026-10-12T10:00:00Z",
    ended: "2026-10-12T10:00:03Z",
    previous: true,
    said: null,
    log: { says: "notRead" },
    limit: null,
    ...over,
  };
}

const exits = (
  ended: EndedRun | null,
  until: string | null = null
): PodCause => ({
  says: "exits",
  container: "api",
  restarts: 7,
  run: ended,
  until,
});

describe("exitMeaning", () => {
  /** Each standard exit has its own meaning. Fails if one is dropped or swapped for another. */
  it.each([
    [{ code: 0, reason: "Completed" }, "finished successfully"],
    [{ code: 126 }, "cannot be run"],
    [{ code: 127 }, "was not found in the image"],
    [{ code: 137 }, "SIGKILL"],
    [{ code: 139 }, "segmentation fault"],
    [{ code: 143 }, "SIGTERM"],
    [{ code: 134 }, "SIGABRT"],
    [{ code: 130 }, "signal 2"],
    [{ code: 0, signal: 9 }, "SIGKILL"],
  ])("reads %o as %s", (over, meaning) => {
    expect(exitMeaning(run(over), t)).toContain(meaning);
  });

  /** An OOM kill is measured against the container's limit. Fails if the limit is dropped, or invented where none is declared. */
  it("measures an OOM kill against the limit, and says when there is none", () => {
    const oom = { code: 137, reason: "OOMKilled" };
    expect(exitMeaning(run({ ...oom, limit: "256Mi" }), t)).toBe(
      "killed for using more memory than its 256Mi limit"
    );
    expect(exitMeaning(run(oom), t)).toContain("no limit of its own");
  });

  /** Exit 1 is the app's own: the meaning is its message, which the cause quotes. */
  it("leaves exit 1 to the app's own words", () => {
    expect(exitMeaning(run(), t)).toBeNull();
  });
});

describe("causeWords", () => {
  /**
   * shop/checkout: the headline was "CrashLoopBackOff, 7 restarts". Fails
   * if the exit, its run time or the app's own message stops leading.
   */
  it("leads with the exit, how long it ran and the app's message", () => {
    const words = causeWords(
      exits(
        run({
          said: "starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db\n",
        })
      ),
      t
    );
    expect(words.sentence).toBe("api exited (exit 1, Error), after running 3s");
    expect(words.quote).toEqual({
      label: "Its exit message:",
      text: "Error: couldn't find key DB_PASSWORD in Secret checkout-db",
    });
    expect(words.tone).toBe("err");
  });

  /** The meaning goes into the sentence in both languages; the kubelet's word stays as written. */
  it("puts the meaning in the sentence and keeps OOMKilled untranslated", () => {
    const oom = exits(run({ code: 137, reason: "OOMKilled", limit: "256Mi" }));
    expect(causeText(oom, t)).toContain(
      "exit 137, OOMKilled): killed for using more memory than its 256Mi limit"
    );
    expect(causeText(oom, ru)).toContain("OOMKilled");
    expect(causeText(oom, ru)).toContain("256Mi");
  });

  /** A log the reader could not read is said as such. Fails if a refused or gone log reads as an empty one. */
  it("says why the log is missing rather than nothing", () => {
    const refused = causeWords(exits(run({ log: { says: "refused" } })), t);
    expect(refused.note).toBe("Its log is not readable with this access.");
    const gone = causeWords(exits(run({ log: { says: "gone" } })), t);
    expect(gone.note).not.toBe(refused.note);
    expect(gone.note).toBeTruthy();
  });

  /** The kubelet reported no exit: the sentence says so instead of inventing one. */
  it("says the exit was not reported where there is no run", () => {
    expect(causeWords(exits(null), t).sentence).toContain(
      "did not report how its last run ended"
    );
  });
});

describe("tellingLine", () => {
  /** A panic's last line is a stack frame. Fails if the frame is quoted over the line that says why. */
  it("skips frames and sign-offs to the line that says why", () => {
    const text = [
      "panic: dial tcp 10.0.0.5:5432: connect: connection refused",
      "",
      "goroutine 1 [running]:",
      "main.main()",
      "\t/app/main.go:12 +0x1d",
      "exit status 2",
    ].join("\n");
    expect(tellingLine(text)).toEqual({
      text: "panic: dial tcp 10.0.0.5:5432: connect: connection refused",
      last: false,
    });
  });
});

describe("currentCause", () => {
  /** An exit a container has been up since stops counting. Fails if it lingers past its until, or ends early. */
  it("drops an exit past its until and keeps one before", () => {
    const cause = exits(run(), "2026-10-12T11:00:00Z");
    expect(currentCause(cause, Date.parse("2026-10-12T11:00:01Z"))).toBeNull();
    expect(currentCause(cause, Date.parse("2026-10-12T10:59:59Z"))).toBe(cause);
  });
});

describe("a pod that runs and is not Ready", () => {
  const notReady = (
    probe: Extract<PodCause, { says: "notReady" }>["probe"]
  ): PodCause => ({
    says: "notReady",
    containers: ["web"],
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
    countsFrom: new Date(Date.now() - 10 * 60_000).toISOString(),
    probe,
  });

  /** Fails if the readiness probe stops being quoted, or the time out of its Services stops being said. */
  it("says how long it has been out and quotes the probe", () => {
    const words = causeWords(
      notReady({ says: "http", scheme: "HTTP", path: "/ready", port: "8080" }),
      t
    );
    expect(words.sentence).toBe(
      "web runs but has not been Ready for 12m, so its Services leave it out"
    );
    expect(words.quote).toEqual({
      label: "Its readiness probe:",
      text: "GET /ready on port 8080",
    });
    expect(words.tone).toBe("warn");
  });

  /** No probe is said as no probe. Fails if a missing probe reads as a failing one. */
  it("says there is no readiness probe where none is declared", () => {
    const words = causeWords(notReady(null), t);
    expect(words.quote).toBeNull();
    expect(words.note).toContain("no readiness probe");
  });

  /** Not-ready has no exit, so nothing expires it. */
  it("stays current whatever the time", () => {
    const cause = notReady(null);
    expect(currentCause(cause, Date.now() + 86_400_000)).toBe(cause);
  });
});

describe("a container the kubelet cannot start", () => {
  const blocked = (
    over: Partial<Extract<PodCause, { says: "blocked" }>>
  ): PodCause => ({
    says: "blocked",
    container: "api",
    reason: "ErrImagePull",
    said: "pull access denied for registry.example/shop/api",
    image: "registry.example/shop/api:9",
    pull: "denied",
    secrets: [],
    ...over,
  });

  /** Fails if a refused pull stops saying which pull secrets the pod names, or that it names none. */
  it("says which pull secrets a refused pull had to offer", () => {
    const none = causeWords(blocked({}), t);
    expect(none.sentence).toBe(
      "api cannot start: the registry refused to hand over registry.example/shop/api:9"
    );
    expect(none.note).toContain("names no pull secret");
    expect(none.quote?.text).toBe(
      "pull access denied for registry.example/shop/api"
    );
    expect(causeWords(blocked({ secrets: ["regcred"] }), t).note).toBe(
      "The pod names the pull secrets regcred."
    );
  });

  /** Each registry answer reads as itself. Fails if two share a sentence. */
  it("words each registry answer apart", () => {
    const sentences = (
      [
        "notFound",
        "denied",
        "rateLimited",
        "unreachable",
        "backingOff",
        "other",
      ] as const
    ).map((pull) => causeWords(blocked({ pull }), t).sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  /** The missing key is the kubelet's sentence. Fails if the config error loses it. */
  it("quotes the kubelet on a config error", () => {
    const words = causeWords(
      blocked({
        reason: "CreateContainerConfigError",
        pull: null,
        said: "couldn't find key DB_PASSWORD in Secret team-checkout/checkout-db",
      }),
      t
    );
    expect(words.sentence).toContain("ConfigMap or Secret is missing");
    expect(words.quote).toEqual({
      label: "The kubelet said:",
      text: "couldn't find key DB_PASSWORD in Secret team-checkout/checkout-db",
    });
  });
});

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/shared-cause-conformance.json"),
    "utf8"
  )
) as {
  cases: {
    name: string;
    pods: { gone: boolean; cause: PodCause | null }[];
    is: { from: number; pods: number; of: number } | null;
  }[];
};

describe("sharedCause", () => {
  /**
   * The StatefulSet, DaemonSet and Job pages read their pods here and the
   * Overview's rows read them in Rust. Fails if this side answers any case
   * of the shared corpus differently, which would put two causes on one
   * workload.
   */
  it("answers every case in the shared corpus as the backend does", () => {
    for (const { name, pods, is } of corpus.cases)
      expect(sharedCause(pods), name).toEqual(
        is && { cause: pods[is.from].cause, pods: is.pods, of: is.of }
      );
  });
});

describe("a pod the kubelet has not set up", () => {
  const creating = (
    kubelet: Extract<PodCause, { says: "creating" }>["kubelet"],
    sandbox: boolean | null = false
  ): PodCause => ({
    says: "creating",
    uid: "u1",
    since: new Date(Date.now() - 4 * 60_000).toISOString(),
    sandbox,
    kubelet,
  });
  const mount = (
    volume: string,
    kind: string,
    name: string,
    at: string
  ): SetupWarning => ({
    reason: "FailedMount",
    said: `MountVolume.SetUp failed for volume "${volume}" : ${kind.toLowerCase()} "${name}" not found`,
    count: 7,
    at,
    fault: { says: "missing", volume, kind, name },
  });

  /**
   * no-config's pods sat in ContainerCreating with nothing on the page
   * saying why. Fails if the objects that do not exist stop leading, in
   * either language, or the kubelet's own line stops being quoted.
   */
  it("names every object its volumes mount that does not exist", () => {
    const warned = creating({
      says: "read",
      warnings: [
        mount("creds", "Secret", "web-creds", "2026-10-14T22:59:19Z"),
        mount("cfg", "ConfigMap", "web-config", "2026-10-14T22:59:00Z"),
        mount("creds", "Secret", "web-creds", "2026-10-14T22:58:00Z"),
      ],
    });
    const words = causeWords(warned, t);
    expect(words.sentence).toBe(
      "Secret web-creds and ConfigMap web-config do not exist, so the kubelet cannot mount them"
    );
    expect(words.quote?.text).toBe(
      'FailedMount: MountVolume.SetUp failed for volume "creds" : secret "web-creds" not found'
    );
    expect(words.tone).toBe("err");
    expect(causeWords(warned, ru).sentence).toContain(
      "Secret web-creds и ConfigMap web-config не существуют"
    );
  });

  /** Fails if a sandbox the network plugin failed reads as a volume. */
  it("says the sandbox where the network plugin failed it", () => {
    const words = causeWords(
      creating({
        says: "read",
        warnings: [
          {
            reason: "FailedCreatePodSandBox",
            said: "Failed to create pod sandbox: plugin type=calico failed (add)",
            count: 3,
            at: null,
            fault: { says: "sandbox" },
          },
        ],
      }),
      t
    );
    expect(words.sentence).toContain("cannot create its sandbox");
  });

  /**
   * Warnings expire after an hour, and an unread events list is not one
   * that holds none. Fails if a guess stops being labelled as one, or if
   * any state of the read is said like another.
   */
  it("labels a guess as one and keeps every state of the read apart", () => {
    const quiet = causeWords(creating({ says: "read", warnings: [] }), t);
    expect(quiet.note).toContain(
      "Probably a volume it mounts or the network plugin"
    );
    expect(quiet.tone).toBe("warn");
    const unknown = causeWords(
      creating({ says: "read", warnings: [] }, null),
      t
    );
    expect(unknown.note).toContain("a slow image pull");
    const states: Extract<PodCause, { says: "creating" }>["kubelet"][] = [
      { says: "notRead" },
      { says: "reading" },
      { says: "refused" },
      { says: "failed", said: "the server is unavailable" },
      { says: "read", warnings: [] },
    ];
    const notes = states.map(
      (kubelet) => causeWords(creating(kubelet), t).note
    );
    expect(new Set(notes).size).toBe(notes.length);
    expect(causeWords(creating({ says: "notRead" }), t).sentence).toBe(
      "Placed on a node 4m ago, and the kubelet has not started its containers"
    );
  });

  /** Nothing expires a wait for the kubelet; only the pod's next state does. */
  it("stays current whatever the time", () => {
    const cause = creating({ says: "notRead" });
    expect(currentCause(cause, Date.now() + 86_400_000)).toBe(cause);
  });
});

describe("a pod whose topology spread is keyed by a label no node carries", () => {
  const unplaced = (keys: string[]): PodCause => ({
    says: "unplaced",
    said: "0/2 nodes are available: 2 node(s) didn't match pod topology spread constraints (missing required label).",
    since: null,
    nodes: 2,
    why: [{ says: "topologyUnlabelled", nodes: 2, keys }],
  });

  /** topology-demo read "would break its topology spread" while no node had the label; fails if the missing label is not named. */
  it("names the label the nodes lack rather than a spread they would break", () => {
    const zone = unplaced(["topology.kubernetes.io/zone"]);
    expect(causeText(zone, t)).toContain(
      "2 nodes lack topology.kubernetes.io/zone, the label its topology spread is keyed by."
    );
    expect(causeText(zone, t)).not.toContain("would break");
    expect(causeText(zone, ru)).toContain(
      "у 2 узлов нет метки topology.kubernetes.io/zone, по которой его topology spread распределяет поды"
    );
  });

  /** The scheduler does not say which key it missed; fails if one of several is named as the one. */
  it("lists every key as one of them where the spread is keyed by several", () => {
    expect(
      causeText(
        unplaced(["example.com/rack", "topology.kubernetes.io/zone"]),
        t
      )
    ).toContain(
      "2 nodes lack one of the labels its topology spread is keyed by (example.com/rack, topology.kubernetes.io/zone)."
    );
  });

  /** Fails if a spec with no key to name prints an empty name. */
  it("says a label is missing where the spec names no key", () => {
    expect(causeText(unplaced([]), t)).toContain(
      "2 nodes lack a label its topology spread is keyed by."
    );
  });
});
