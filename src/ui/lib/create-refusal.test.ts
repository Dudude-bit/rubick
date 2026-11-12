import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  createRefusal,
  jobWord,
  refusalGist,
  refusalText,
  refusedUid,
  toldRuns,
} from "./create-refusal";

const t: T = (section, key, values) => translate("en", section, key, values);

interface Case {
  name: string;
  uid: string;
  events: {
    type: string;
    reason: string;
    uid: string;
    message: string | null;
    lastTimestamp: string | null;
  }[];
  podsCreated: (string | null)[];
  refused: string | null;
}

const corpus = (
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), "src/contracts/create-refusal-conformance.json"),
      "utf8"
    )
  ) as { cases: Case[] }
).cases;

const event = (
  over: Partial<Case["events"][number]> & { kind?: string; name?: string }
): EventInfo => ({
  name: "e",
  namespace: "shop",
  uid: "e",
  type: over.type ?? "Warning",
  reason: over.reason ?? "FailedCreate",
  message: over.message ?? null,
  source: null,
  involvedObject: {
    kind: over.kind ?? "StatefulSet",
    name: over.name ?? "db",
    namespace: "shop",
    uid: over.uid ?? null,
  },
  count: 1,
  firstTimestamp: null,
  lastTimestamp: over.lastTimestamp ?? null,
});

describe("whether the API server refuses a controller's pods", () => {
  /**
   * The Overview reads a refusal in Rust and every list, page and peek
   * here. Fails if the two answer one case of the shared corpus apart.
   */
  it.each(corpus.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(
      createRefusal(c.uid, c.events.map(event), c.podsCreated)
    ).toStrictEqual(c.refused);
  });

  /** A CronJob's run is named on its row, not identified; fails if its refusal is not found by name, or another namespace's is taken. */
  it("finds the run a refusal names by its kind and name", () => {
    const events = [
      event({
        kind: "Job",
        name: "nightly-1",
        uid: "old",
        lastTimestamp: "2026-10-15T07:00:00Z",
      }),
      event({
        kind: "Job",
        name: "nightly-1",
        uid: "new",
        lastTimestamp: "2026-10-15T08:00:00Z",
      }),
    ];
    expect(refusedUid(events, "Job", "shop", "nightly-1")).toBe("new");
    expect(refusedUid(events, "Job", "ops", "nightly-1")).toBeNull();
  });
});

describe("how a refusal is said", () => {
  /** Fails if a row leads with the name of a pod that never existed rather than the reason. */
  it("says the reason without the pod's name, and the whole answer where it has no such part", () => {
    expect(
      refusalGist(
        'pods "root-web-d786dc494-2vntp" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true'
      )
    ).toBe('violates PodSecurity "restricted:latest": runAsNonRoot != true');
    expect(refusalGist("Timeout: request did not complete")).toBe(
      "Timeout: request did not complete"
    );
    expect(refusalText("", t)).toBe(
      "The API server refuses to create its pods"
    );
  });

  /**
   * Live, a PodSecurity refusal filled four lines of every Overview row and
   * a list cell cut it at "violates PodSecurity "re...". Fails if a row stops
   * naming who refused, or a shape falls back to quoting the answer.
   */
  it.each([
    [
      'Error creating: pods "root-job-dw9qj" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "sleeper" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "sleeper" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "sleeper" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "sleeper" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")',
      "Pod Security restricted refuses its pods: 4 checks fail",
    ],
    [
      'pods "node-peek-5649c97885-zqqdt" is forbidden: violates PodSecurity "baseline:v1.33": host namespaces (hostNetwork=true)',
      "Pod Security baseline:v1.33 refuses its pods: 1 check fails",
    ],
    [
      'pods "capped-6d67bcbdbc-bl2gn" is forbidden: exceeded quota: two-pods, requested: pods=1, used: pods=2, limited: pods=2',
      "ResourceQuota two-pods refuses its pods: no room for pods",
    ],
    [
      'pods "unbounded-8f8bd5d6-bcrk9" is forbidden: failed quota: compute: must specify limits.cpu for: app; limits.memory for: app,sidecar',
      "ResourceQuota compute refuses its pods: limits.cpu, limits.memory not set",
    ],
    [
      'pods "greedy-ddc468465-hdsd6" is forbidden: [maximum cpu usage per Container is 500m, but limit is 1, maximum memory usage per Container is 256Mi, but limit is 512Mi]',
      "A LimitRange refuses its pods: cpu, memory out of bounds",
    ],
    [
      'pods "lost-sa-5d659d7bd7-" is forbidden: error looking up service account refused-sa/ghost: serviceaccount "ghost" not found',
      "Its pods are refused: ServiceAccount ghost does not exist",
    ],
    [
      "pods \"unlabeled-cbbf4cf64-fndqd\" is forbidden: ValidatingAdmissionPolicy 'require-team-label' with binding 'require-team-label-binding' denied request: every pod needs a team label",
      "ValidatingAdmissionPolicy require-team-label refuses its pods: every pod needs a team label",
    ],
    [
      'Internal error occurred: failed calling webhook "pods.guard.example.com": failed to call webhook: Post "https://guard.refused-hook.svc:443/validate?timeout=10s": service "guard" not found',
      "Its pods are refused: admission webhook pods.guard.example.com cannot be reached",
    ],
    [
      'pods "web-1" is forbidden: admission webhook "policy.example" denied the request without explanation',
      "Admission webhook policy.example refuses its pods",
    ],
    [
      'pods "web-1" is forbidden: unable to create new content in namespace shop because it is being terminated',
      "Its pods are refused: namespace shop is being deleted",
    ],
    [
      'pods "web-1" is forbidden: node "a" not ready',
      'The API server refuses to create its pods: node "a" not ready',
    ],
  ])("says who refused %j in a row's few words", (said, text) => {
    expect(refusalText(said, t)).toBe(text);
  });

  /** Fails if a Job with pods running, retrying or done is relabelled, or a refused Pending one is not. */
  it("calls a Pending Job whose pods are refused FailedCreate, and no other", () => {
    expect(jobWord("Pending", "exceeded quota")).toBe("FailedCreate");
    expect(jobWord("Pending", "")).toBe("FailedCreate");
    expect(jobWord("Pending", null)).toBe("Pending");
    expect(jobWord("Running", "exceeded quota")).toBe("Running");
  });
});

describe("runs told with their refusals", () => {
  /**
   * A CronJob's runs bar and Jobs tab drew a refused run as Pending. Fails if
   * a Pending run with a refusal is not FailedCreate, a run of another word
   * is changed, or the runs are told before the refusals are read.
   */
  it("turns only a refused Pending run into FailedCreate", () => {
    const runs = [
      { uid: "a", status: "Pending" },
      { uid: "b", status: "Pending" },
      { uid: "c", status: "Running" },
    ];
    const refusals = [
      event({ uid: "a", message: "refused" }),
      event({ uid: "c", message: "refused" }),
    ];
    expect(toldRuns(runs, refusals).map((run) => run.status)).toEqual([
      "FailedCreate",
      "Pending",
      "Running",
    ]);
    expect(toldRuns(runs, null)).toBe(runs);
  });
});
