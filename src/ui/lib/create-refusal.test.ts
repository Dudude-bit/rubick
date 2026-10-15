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
   * a list cell cut it at "violates PodSecurity "re...", the checks it failed
   * pushed out by how to pass each. Fails if the short form keeps the how,
   * drops a check, or strips the parentheses of any other refusal.
   */
  it("keeps the checks a PodSecurity refusal failed and leaves out how to pass them", () => {
    expect(
      refusalGist(
        'Error creating: pods "root-job-dw9qj" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "sleeper" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "sleeper" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "sleeper" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "sleeper" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")'
      )
    ).toBe(
      'violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile'
    );
    expect(
      refusalGist(
        'pods "web-1" is forbidden: admission webhook "policy.example" denied the request: image (latest tag) is not allowed'
      )
    ).toBe(
      'admission webhook "policy.example" denied the request: image (latest tag) is not allowed'
    );
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
