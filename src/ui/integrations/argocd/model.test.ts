import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import {
  appState,
  autoSyncOn,
  byKind,
  byTrouble,
  differing,
  lastSyncOf,
  projectDestinationsWords,
  projectReposWords,
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
    generation: null,
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
          group: "apps",
          kind: "Deployment",
          namespace: "nowhere",
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

describe("an Application that is not in sync and has no failure to show", () => {
  const leftOutOfSync = {
    sync: { status: "OutOfSync", revision: SHA },
    health: { status: "Healthy" },
    operationState: {
      phase: "Succeeded",
      message: "successfully synced (all tasks run)",
      finishedAt: "2026-07-20T10:00:00Z",
    },
  };

  /**
   * Auto-sync without prune after a manifest left git, a closed sync window,
   * an edit in the cluster with self-heal off: Argo leaves the Application
   * OutOfSync with a succeeded operation and no condition. It had no
   * finding, so it was green, sorted with the healthy ones and counted under
   * "all in sync". Fails if auto-sync being on hides drift again.
   */
  it("is drift whether or not auto-sync is on", () => {
    const app = readApplication(
      application("shop", { syncPolicy: { automated: {} } }, leftOutOfSync)
    );
    expect(app.findings).toEqual([
      {
        kind: "drifted",
        severity: "warn",
        since: "2026-07-20T10:00:00Z",
        autoSync: true,
      },
    ]);
    expect(appState(app, t)).toEqual({
      text: "out of sync · healthy",
      tone: "warn",
    });
    const healthy = readApplication(
      application(
        "aaa",
        {},
        { sync: { status: "Synced" }, health: { status: "Healthy" } }
      )
    );
    expect(byTrouble([healthy, app]).map((one) => one.name)).toEqual([
      "shop",
      "aaa",
    ]);
  });

  /**
   * A new Application, or one in a namespace the controller does not watch,
   * has no status. `Unknown` by default and no finding made it "not compared
   * · unknown" in green. Fails if silence from Argo reads as in sync.
   */
  it("is not compared, and not ok, where Argo wrote no status", () => {
    const app = readApplication(application("shop", {}, {}));
    expect(app.findings).toEqual([{ kind: "notCompared", severity: "warn" }]);
    expect(appState(app, t)).toEqual({
      text: "not compared · unknown",
      tone: "warn",
    });
  });

  /**
   * Where Argo says why it could not compare, its sentence is the answer.
   * Fails if "has not reached it yet" is printed beside a ComparisonError.
   */
  it("leaves the reason to Argo's own error where it reports one", () => {
    const app = readApplication(
      application(
        "shop",
        {},
        {
          sync: { status: "Unknown" },
          conditions: [{ type: "ComparisonError", message: "repo not found" }],
        }
      )
    );
    expect(app.findings.map((finding) => finding.kind)).toEqual(["condition"]);
    expect(app.worst).toBe("err");
  });

  /**
   * Fails if a state with no finding is green by default: suspended,
   * progressing and a health Argo could not assess are not "ok".
   */
  it.each([
    ["Healthy", "ok"],
    ["Progressing", "warn"],
    ["Suspended", "warn"],
    ["Unknown", "warn"],
  ])("draws synced and %s as %s", (health, tone) => {
    const app = readApplication(
      application(
        "shop",
        {},
        { sync: { status: "Synced" }, health: { status: health } }
      )
    );
    expect(app.findings).toEqual([]);
    expect(appState(app, t).tone).toBe(tone);
  });
});

describe("whether auto-sync is on", () => {
  /**
   * Argo CD 3.1 reads `automated.enabled: false` as no automated sync at
   * all, whatever stands beside it. Read as on, the Application had no
   * drift finding and every object it manages warned that an edit would be
   * undone. Fails if the presence of `automated` alone is taken for on.
   */
  it("is off where automated is there and disabled", () => {
    const app = readApplication(
      application(
        "shop",
        {
          syncPolicy: {
            automated: { enabled: false, prune: true, selfHeal: true },
          },
        },
        { sync: { status: "OutOfSync" }, health: { status: "Healthy" } }
      )
    );
    expect(app.autoSync).toBe(false);
    expect(app.selfHeal).toBe(false);
    expect(app.findings).toMatchObject([{ kind: "drifted", autoSync: false }]);
  });

  /** Versions before 3.1 have no such field, and 3.1 defaults it to on. */
  it.each([[{}], [{ enabled: true }], [{ selfHeal: true }]])(
    "is on for %o",
    (automated) => {
      expect(autoSyncOn(automated)).toBe(true);
    }
  );

  it.each([[null], [undefined]])("is off for %o", (automated) => {
    expect(autoSyncOn(automated)).toBe(false);
  });
});

describe("a sync that is running", () => {
  const HOOK = "waiting for completion of hook batch/Job/migrate";
  /** As Argo writes it from the start of an operation to its end: no `finishedAt`. */
  const running = (over: Record<string, unknown> = {}) => ({
    sync: { status: "OutOfSync", revision: SHA },
    health: { status: "Healthy" },
    operationState: {
      phase: "Running",
      message: HOOK,
      startedAt: "2026-08-07T10:00:00Z",
    },
    history: [
      { id: 0, revision: SHA, deployedAt: "2026-07-01T09:00:00Z" },
      { id: 1, revision: SHA, deployedAt: "2026-08-01T09:00:00Z" },
    ],
    ...over,
  });

  /**
   * Argo clears `finishedAt` for as long as an operation runs, so an
   * Application synced fifty times read "never synced", and with auto-sync
   * off "nothing is going to fix this on its own", behind a hook that had
   * been running for an hour. Fails if a running operation is read as no
   * operation.
   */
  it("is said to be running, with what Argo says it waits for, and not as drift nobody is fixing", () => {
    const app = readApplication(application("shop", {}, running()));
    expect(app.findings).toEqual([
      {
        kind: "syncing",
        severity: "warn",
        message: HOOK,
        since: "2026-08-07T10:00:00Z",
      },
    ]);
    expect(app.worst).toBe("warn");
  });

  /** Fails if the last recorded sync stops standing in while the next runs. */
  it("keeps the age of the last recorded sync", () => {
    const app = readApplication(application("shop", {}, running()));
    expect(app.lastSyncAt).toBe("2026-08-01T09:00:00Z");
    expect(lastSyncOf(app)).toEqual({ at: "2026-08-01T09:00:00Z" });
  });

  /**
   * `revisionHistoryLimit: 0` keeps no history, and the first sync has none
   * yet. Neither is "never synced". Fails if a missing time is read as never.
   */
  it("is not called never synced where Argo keeps no history", () => {
    const app = readApplication(
      application("shop", {}, running({ history: undefined }))
    );
    expect(app.lastSyncAt).toBeNull();
    expect(lastSyncOf(app)).toBe("running");
  });

  /** The one case "never" is true of: Argo recorded no operation at all. */
  it("is called never synced only where no operation was recorded", () => {
    const app = readApplication(
      application("shop", {}, { sync: { status: "OutOfSync" } })
    );
    expect(lastSyncOf(app)).toBe("never");
  });

  /**
   * A retry in progress has no `finishedAt` either, and Argo 3 clears the
   * failed results when it starts. Fails if that reads as a first attempt
   * under way, or if "failing for" takes its age from the last good sync.
   */
  it("is still a failing sync while a retry of it runs", () => {
    const app = readApplication(
      application(
        "shop",
        { syncPolicy: { automated: {} } },
        running({
          operationState: {
            phase: "Running",
            message: `${SYNC_FAILURE}. Retrying attempt #2 at 10:05AM.`,
            startedAt: "2026-08-07T10:00:00Z",
            retryCount: 2,
          },
        })
      )
    );
    expect(app.findings).toMatchObject([
      { kind: "syncFailing", retries: 2, since: null },
    ]);
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

  const REFUSAL =
    'networkpolicies.networking.k8s.io "default-deny" is forbidden';
  const policy = (namespace: string, status: string) => ({
    group: "networking.k8s.io",
    kind: "NetworkPolicy",
    namespace,
    name: "default-deny",
    status,
  });
  const twoNamespaces = (results: unknown[]) =>
    readApplication(
      application(
        "tenants",
        { syncPolicy: { automated: {} } },
        {
          sync: { status: "OutOfSync" },
          health: { status: "Healthy" },
          operationState: {
            phase: "Running",
            syncResult: { resources: results },
          },
          resources: [
            policy("team-a", "Synced"),
            policy("team-b", "OutOfSync"),
          ],
        }
      )
    );
  const applied = { ...policy("team-a", "Synced"), message: "configured" };
  const refused = { ...policy("team-b", "SyncFailed"), message: REFUSAL };

  /**
   * One Application holds a `default-deny` in every tenant's namespace. By
   * kind and name the first result answered for both rows: the refused
   * object lost its refusal, or the applied one was drawn refused. Fails if
   * the namespace stops being part of which result is about which row.
   */
  it.each([
    ["the applied one first", [applied, refused]],
    ["the refused one first", [refused, applied]],
  ])(
    "gives a refusal to the namesake it was about, with %s",
    (_order, results) => {
      const app = twoNamespaces(results);
      const row = (namespace: string) =>
        app.resources.find((resource) => resource.namespace === namespace);

      expect(row("team-b")).toMatchObject({
        outcome: "SyncFailed",
        message: REFUSAL,
      });
      expect(row("team-a")).toMatchObject({ outcome: "Synced", message: null });
      expect(app.findings.map((finding) => finding.kind)).toEqual([
        "syncFailing",
      ]);
    }
  );

  /**
   * Knative's Service and the core one share a kind and a name. Fails if a
   * result is matched without its group.
   */
  it("does not give a refusal to the same kind name in another group", () => {
    const service = (group: string | undefined, status: string) => ({
      ...(group === undefined ? {} : { group }),
      kind: "Service",
      namespace: "shop",
      name: "api",
      status,
    });
    const app = readApplication(
      application(
        "shop",
        {},
        {
          operationState: {
            phase: "Failed",
            syncResult: {
              resources: [
                {
                  ...service("serving.knative.dev", "SyncFailed"),
                  message: REFUSAL,
                },
                // The core group, as the results spell it.
                service("", "Synced"),
              ],
            },
          },
          resources: [
            // And as the rows do: left out.
            service(undefined, "Synced"),
            service("serving.knative.dev", "OutOfSync"),
          ],
        }
      )
    );
    expect(app.resources.map((resource) => resource.outcome)).toEqual([
      "Synced",
      "SyncFailed",
    ]);
  });

  /**
   * A sync stamps the destination namespace on a cluster-scoped object, so
   * its result has one and its row has none. Fails if a strict namespace
   * match drops the refusal of a Namespace or a ClusterRole.
   */
  it("keeps the refusal of a cluster-scoped object, whose result carries the destination namespace", () => {
    const app = readApplication(
      application(
        "shop",
        {},
        {
          operationState: {
            phase: "Failed",
            syncResult: {
              resources: [
                {
                  group: "rbac.authorization.k8s.io",
                  kind: "ClusterRole",
                  namespace: "shop",
                  name: "reader",
                  status: "SyncFailed",
                  message: REFUSAL,
                },
              ],
            },
          },
          resources: [
            {
              group: "rbac.authorization.k8s.io",
              kind: "ClusterRole",
              name: "reader",
              status: "OutOfSync",
            },
          ],
        }
      )
    );
    expect(app.resources[0]).toMatchObject({
      outcome: "SyncFailed",
      message: REFUSAL,
    });
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

describe("what a project allows, in words", () => {
  const say = t;

  /** `*` with a `!pattern` is "everything but", and dropping the exclusion misstates the project. */
  it("keeps a repository a project denies beside its wildcard", () => {
    expect(
      projectReposWords(["*", "!https://github.com/example/restricted-*"], say)
    ).toBe("any repository except https://github.com/example/restricted-*");
    expect(projectReposWords(["*"], say)).toBe("any repository");
    expect(projectReposWords([], say)).toBe("no repository allowed");
  });

  /** A destination named by cluster name, with no server, is one cluster, not any. */
  it("names a destination's cluster by name when it has no server", () => {
    expect(
      projectDestinationsWords([{ namespace: "shop", name: "prod-eu" }], say)
    ).toContain("prod-eu");
    expect(
      projectDestinationsWords([{ namespace: "shop", server: "*" }], say)
    ).toContain("any cluster");
  });
});

/**
 * A repository address may carry the token it is cloned with, and the page,
 * the shared file, the Managed by line and the connections graph all draw
 * what the model read. Fails if the model hands any of them the address as
 * written, or loses the host and the path.
 */
describe("a repository address with a token in it", () => {
  const remote =
    "https://oauth2:glpat-" +
    "AbCdEf0123456789xyzQ@gitlab.example.com/org/repo.git";

  it("is read without what stands before the host", () => {
    const app = readApplication(
      application("shop", { source: { repoURL: remote, path: "apps" } }, {})
    );
    expect(app.sources.map((source) => source.repoUrl)).toEqual([
      "https://…@gitlab.example.com/org/repo.git",
    ]);
  });

  it("is named the same way among a project's allowed repositories", () => {
    expect(projectReposWords([remote, "https://github.com/acme/*"], t)).toBe(
      "https://…@gitlab.example.com/org/repo.git, https://github.com/acme/*"
    );
  });
});
