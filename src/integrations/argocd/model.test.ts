import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import {
  appState,
  byKind,
  byTrouble,
  differing,
  readApplication,
  resourceTone,
  type ArgoResource,
} from "./model";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const SHA = "eec06d1ea459af4cb4e10e806f8be7c7bd58b361";

function application(
  name: string,
  spec: Record<string, unknown>,
  status: Record<string, unknown>,
  ownerReferences: CustomResourceInfo["ownerReferences"] = []
): CustomResourceInfo {
  return {
    name,
    namespace: "argocd",
    uid: name,
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    spec: {
      project: "default",
      source: {
        repoURL: "https://github.com/acme/infra",
        path: "manifests",
        targetRevision: "main",
      },
      destination: {
        server: "https://kubernetes.default.svc",
        namespace: "shop",
      },
      ...spec,
    },
    status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences,
  };
}

const SYNC_FAILURE =
  'one or more objects failed to apply, reason: namespaces "nowhere" not found';

/** The retrying automated sync, exactly as Argo reports it mid-retry. */
const failingStatus = {
  sync: { status: "OutOfSync", revision: SHA },
  health: { status: "Missing" },
  operationState: {
    phase: "Running",
    message: SYNC_FAILURE,
    finishedAt: "2026-08-07T10:00:00Z",
    retryCount: 5,
    syncResult: {
      resources: [
        {
          kind: "Deployment",
          name: "shop-api",
          status: "SyncFailed",
          message: 'namespaces "nowhere" not found',
        },
      ],
    },
  },
  resources: [
    {
      group: "apps",
      kind: "Deployment",
      name: "shop-api",
      namespace: "nowhere",
      status: "OutOfSync",
    },
  ],
};

describe("the two ways an Application is OutOfSync", () => {
  /**
   * The page's whole reason to exist. Both applications below report
   * `OutOfSync` and would sit in the same red column in any list Argo or this
   * app has ever drawn — and one is a machine failing forever while the other
   * is a decision nobody made. Would break if the two ever collapsed into one
   * finding, or if either lost the fact that decides which it is.
   */
  it("tells a sync failing under auto-sync apart from drift nobody is fixing", () => {
    const failing = readApplication(
      application(
        "shop",
        { syncPolicy: { automated: { selfHeal: true } } },
        failingStatus
      )
    );
    const drifted = readApplication(
      application(
        "analytics",
        {},
        {
          sync: { status: "OutOfSync", revision: SHA },
          health: { status: "Healthy" },
          operationState: {
            phase: "Succeeded",
            message: "successfully synced",
            finishedAt: "2026-07-20T10:00:00Z",
          },
          resources: [
            {
              group: "apps",
              kind: "Deployment",
              name: "podinfo",
              namespace: "analytics",
              status: "OutOfSync",
            },
          ],
        }
      )
    );

    // Same word from Argo…
    expect(failing.sync).toBe("OutOfSync");
    expect(drifted.sync).toBe("OutOfSync");

    // …and opposite problems.
    const failure = failing.findings.find(
      (finding) => finding.kind === "syncFailing"
    );
    expect(failure?.kind === "syncFailing" && failure.message).toBe(
      SYNC_FAILURE
    );
    expect(failure?.severity).toBe("err");
    expect(failing.autoSync).toBe(true);

    expect(drifted.findings.map((finding) => finding.kind)).toEqual([
      "drifted",
    ]);
    expect(drifted.worst).toBe("warn");
    expect(drifted.autoSync).toBe(false);
  });

  /**
   * `phase` alone is not enough. A retrying automated sync sits at `Running`
   * with every object already refused, and calling that "in progress" would
   * draw a spinner over a manifest the API server has rejected five times.
   */
  it("reads a retrying sync as failing rather than as in progress", () => {
    const app = readApplication(
      application("shop", { syncPolicy: { automated: {} } }, failingStatus)
    );
    expect(app.operationPhase).toBe("Running");
    expect(app.findings[0].kind).toBe("syncFailing");
  });

  /** A failed sync with nobody retrying it is a third sentence, not the first. */
  it("says so when the last manual sync failed and auto-sync is off", () => {
    const app = readApplication(
      application(
        "shop",
        {},
        {
          ...failingStatus,
          operationState: { ...failingStatus.operationState, phase: "Failed" },
        }
      )
    );
    expect(app.findings[0].kind).toBe("syncFailedOnce");
  });
});

describe("which resources differ, and why in Argo's words", () => {
  it("carries the API server's own refusal onto the resource row", () => {
    const app = readApplication(
      application("shop", { syncPolicy: { automated: {} } }, failingStatus)
    );
    const changed = differing(app);
    expect(changed).toHaveLength(1);
    expect(changed[0].outcome).toBe("SyncFailed");
    expect(changed[0].message).toBe('namespaces "nowhere" not found');
  });

  /**
   * The tier boundary. Where Argo says only `OutOfSync`, this must carry no
   * message at all rather than inventing one — which fields differ is in
   * Argo's API behind a token.
   */
  it("says nothing about a resource Argo only called OutOfSync", () => {
    const app = readApplication(
      application(
        "analytics",
        {},
        {
          sync: { status: "OutOfSync" },
          health: { status: "Healthy" },
          resources: [
            {
              kind: "ConfigMap",
              name: "shop-config",
              namespace: "shop",
              status: "OutOfSync",
            },
          ],
        }
      )
    );
    expect(differing(app)[0].message).toBeNull();
  });
});

describe("an Application a generator made", () => {
  /**
   * Editing a generated Application is undone the next time the ApplicationSet
   * runs, and the reader about to do it has no other way to find out. Read
   * from `ownerReferences` rather than a label, because that is the fact and
   * not a convention anyone can copy onto a hand-written object.
   */
  it("names the ApplicationSet that owns it", () => {
    const app = readApplication(
      application(
        "tenant-a",
        {},
        { sync: { status: "Synced" }, health: { status: "Healthy" } },
        [
          {
            apiVersion: "argoproj.io/v1alpha1",
            kind: "ApplicationSet",
            name: "tenants",
            uid: "set",
            controller: true,
          },
        ]
      )
    );
    expect(app.generatedBy).toEqual({
      kind: "ApplicationSet",
      name: "tenants",
    });
  });

  it("leaves a hand-written Application unclaimed", () => {
    const app = readApplication(
      application(
        "shop",
        {},
        { sync: { status: "Synced" }, health: { status: "Healthy" } }
      )
    );
    expect(app.generatedBy).toBeNull();
  });
});

describe("the list is ordered by trouble", () => {
  it("puts failures first, then the alphabet, so a reload never reshuffles it", () => {
    const healthy = readApplication(
      application(
        "aaa",
        {},
        { sync: { status: "Synced" }, health: { status: "Healthy" } }
      )
    );
    const drifted = readApplication(
      application(
        "zzz",
        {},
        { sync: { status: "OutOfSync" }, health: { status: "Healthy" } }
      )
    );
    const failing = readApplication(
      application("mmm", { syncPolicy: { automated: {} } }, failingStatus)
    );
    expect(
      byTrouble([healthy, drifted, failing]).map((app) => app.name)
    ).toEqual(["mmm", "zzz", "aaa"]);
  });

  it("reads a synced healthy Application as ok", () => {
    const app = readApplication(
      application(
        "podinfo",
        { syncPolicy: { automated: {} } },
        {
          sync: { status: "Synced" },
          health: { status: "Healthy" },
        }
      )
    );
    expect(appState(app, t)).toEqual({ text: "synced · healthy", tone: "ok" });
  });
});

describe("what an Application manages", () => {
  const resource = (
    kind: string,
    name: string,
    overrides: Partial<ArgoResource> = {}
  ): ArgoResource => ({
    group: null,
    kind,
    namespace: "web",
    name,
    sync: "Synced",
    health: "Healthy",
    message: null,
    outcome: null,
    ...overrides,
  });

  /**
   * The row used to draw "17 objects" and list only what differed, so a
   * healthy Application said how many things it owned and never which — the
   * wrong half of the question somebody opens it with.
   */
  it("groups every object by kind, not only the ones that differ", () => {
    const groups = byKind([
      resource("Service", "api"),
      resource("Deployment", "api"),
      resource("Deployment", "worker"),
    ]);

    expect(groups.map((group) => group.kind).sort()).toEqual([
      "Deployment",
      "Service",
    ]);
    expect(
      groups.find((group) => group.kind === "Deployment")?.resources
    ).toHaveLength(2);
  });

  /**
   * A Helm release of a hundred objects is the ordinary case, so the two that
   * are failing must not be somewhere in the middle of it.
   */
  it("puts the worst kind first and the worst object inside it first", () => {
    const groups = byKind([
      resource("Service", "api"),
      resource("Deployment", "api"),
      resource("Deployment", "broken", { outcome: "SyncFailed" }),
    ]);

    expect(groups[0].kind).toBe("Deployment");
    expect(groups[0].resources[0].name).toBe("broken");
    expect(groups[0].troubled).toBe(1);
  });

  /** Degraded is trouble even when Argo calls the object Synced. */
  it("counts a synced but degraded object as worth looking at", () => {
    const [group] = byKind([
      resource("Deployment", "api", { health: "Degraded" }),
    ]);
    expect(group.troubled).toBe(1);
    expect(resourceTone(group.resources[0])).toBe("err");
  });

  /** A healthy object earns no colour at all. */
  it("leaves a synced, healthy object uncoloured", () => {
    expect(resourceTone(resource("Service", "api"))).toBeNull();
  });
});
