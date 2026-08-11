import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import {
  fluxPicture,
  readRevision,
  reconcilerState,
  revisionText,
  sourceState,
} from "./model";

const REVISION = "master@sha1:eec06d1ea459af4cb4e10e806f8be7c7bd58b361";

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

function object(
  kind: string,
  name: string,
  spec: Record<string, unknown>,
  status: Record<string, unknown> = {}
): CustomResourceInfo {
  return {
    name,
    namespace: "flux-system",
    uid: `${kind}-${name}`,
    apiVersion: "v1",
    kind,
    spec,
    status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

const ready = (message: string): Condition => ({
  type: "Ready",
  status: "True",
  reason: "ReconciliationSucceeded",
  message,
});

const notReady = (reason: string, message: string): Condition => ({
  type: "Ready",
  status: "False",
  reason,
  message,
});

function kustomization(
  name: string,
  spec: Record<string, unknown>,
  conditions: Condition[],
  lastAppliedRevision?: string
) {
  return object(
    "Kustomization",
    name,
    {
      path: "./apps",
      sourceRef: { kind: "GitRepository", name: "podinfo" },
      ...spec,
    },
    { conditions, lastAppliedRevision }
  );
}

function gitRepository(
  name: string,
  conditions: Condition[],
  artifact?: string
) {
  return object(
    "GitRepository",
    name,
    { url: "https://github.com/acme/infra", ref: { branch: "master" } },
    { conditions, artifact: artifact ? { revision: artifact } : undefined }
  );
}

const picture = (
  kustomizations: CustomResourceInfo[],
  sources: CustomResourceInfo[],
  helmReleases: CustomResourceInfo[] = []
) =>
  fluxPicture(kustomizations, helmReleases, [
    { kind: "GitRepository", objects: sources },
    { kind: "HelmRepository", objects: [] },
  ]);

describe("suspension is never healthy", () => {
  /**
   * The single most important assertion on this page. A suspended
   * Kustomization keeps the `Ready=True` condition it earned on its last
   * successful run, so every list that reads that condition — Flux's own CLI
   * included — calls it healthy while it reconciles nothing. It is the one
   * state that looks perfect and does nothing.
   *
   * Would break if the status word or the tone ever came from the `Ready`
   * condition without checking `spec.suspend` first.
   */
  it("reads as suspended, not ready, when it reports Ready=True", () => {
    const { reconcilers } = picture(
      [
        kustomization(
          "tenant-b",
          { suspend: true },
          [ready(`Applied revision: ${REVISION}`)],
          REVISION
        ),
      ],
      [gitRepository("podinfo", [ready("stored artifact")], REVISION)]
    );

    const state = reconcilerState(reconcilers[0]);
    expect(state.text).toBe("suspended");
    expect(state.tone).not.toBe("ok");
    expect(reconcilers[0].findings.map((finding) => finding.kind)).toContain(
      "suspended"
    );
  });

  /**
   * A suspended reconciler is not fetching and not applying, so what its
   * source is doing is not why the cluster does not match git. Would break if
   * a second red finding started stacking on top of the one sentence that
   * matters.
   */
  it("does not blame a failing source for a reconciler that is suspended", () => {
    const { reconcilers, sources } = picture(
      [
        kustomization(
          "tenant-b",
          { suspend: true },
          [ready(`Applied revision: ${REVISION}`)],
          REVISION
        ),
      ],
      [
        gitRepository(
          "podinfo",
          [notReady("GitOperationFailed", "gone")],
          REVISION
        ),
      ]
    );
    expect(reconcilers[0].findings.map((finding) => finding.kind)).toEqual([
      "suspended",
    ]);
    expect(reconcilers[0].worst).toBe("warn");
    const failing = sources[0].findings.find(
      (finding) => finding.kind === "fetchFailing"
    );
    expect(failing?.kind === "fetchFailing" && failing.frozen).toEqual([]);
  });

  /** A reconciler suspended before it ever ran has nothing applied at all. */
  it("distinguishes suspended-after-running from suspended-from-birth", () => {
    const { reconcilers } = picture(
      [kustomization("never-ran", { suspend: true }, [])],
      [gitRepository("podinfo", [ready("stored artifact")], REVISION)]
    );
    const finding = reconcilers[0].findings.find(
      (candidate) => candidate.kind === "suspended"
    );
    expect(finding).toBeDefined();
    expect(finding?.kind === "suspended" && finding.wasReady).toBe(false);
  });
});

describe("a source that stopped fetching freezes everything under it", () => {
  /**
   * The failure a shared "GitOps" page would have hidden. The source is the
   * only object saying anything is wrong; the Kustomization under it reports
   * `Ready` from the revision it last managed to apply, and the cluster is
   * quietly running old manifests.
   */
  it("marks the applier as frozen even though it reports Ready", () => {
    const { reconcilers, sources } = picture(
      [
        kustomization(
          "apps",
          {},
          [ready(`Applied revision: ${REVISION}`)],
          REVISION
        ),
      ],
      [
        gitRepository(
          "podinfo",
          [
            notReady(
              "GitOperationFailed",
              "failed to checkout and determine revision: authentication required"
            ),
          ],
          REVISION
        ),
      ]
    );

    expect(reconcilers[0].ready).toBe(true);
    expect(reconcilerState(reconcilers[0]).tone).toBe("err");
    const frozen = reconcilers[0].findings.find(
      (finding) => finding.kind === "frozen"
    );
    expect(frozen?.kind === "frozen" && frozen.message).toContain(
      "authentication required"
    );

    // And the source names who is frozen because of it.
    const failing = sources[0].findings.find(
      (finding) => finding.kind === "fetchFailing"
    );
    expect(failing?.kind === "fetchFailing" && failing.frozen).toEqual([
      "apps",
    ]);
    expect(failing?.kind === "fetchFailing" && failing.everFetched).toBe(true);
    expect(sourceState(sources[0]).tone).toBe("err");
  });

  /** Never fetched is a different sentence: nothing was ever applied. */
  it("separates a source that never fetched from one that stopped", () => {
    const { reconcilers } = picture(
      [
        kustomization("platform", {}, [
          notReady("ArtifactFailed", "Source artifact not found"),
        ]),
      ],
      [
        gitRepository("podinfo", [
          notReady("GitOperationFailed", "Repository not found"),
        ]),
      ]
    );
    expect(reconcilers[0].findings.map((finding) => finding.kind)).toContain(
      "noSource"
    );
  });
});

describe("dependsOn is an ordering, and its consequence is named", () => {
  /**
   * Flux writes `dependency 'flux-system/platform' is not ready` on each
   * blocked reconciler — true, and useless on its own. Would break if the
   * page stopped naming *which* reconcilers a stuck one is holding up, which
   * is what turns one red row into an explained outage.
   */
  it("names the reconcilers held up by a stuck one, and what they are waiting on", () => {
    const { reconcilers } = picture(
      [
        kustomization("platform", {}, [
          notReady("ArtifactFailed", "Source artifact not found"),
        ]),
        kustomization("monitoring", { dependsOn: [{ name: "platform" }] }, [
          notReady(
            "DependencyNotReady",
            "dependency 'flux-system/platform' is not ready"
          ),
        ]),
        kustomization("ingress", { dependsOn: [{ name: "platform" }] }, [
          notReady(
            "DependencyNotReady",
            "dependency 'flux-system/platform' is not ready"
          ),
        ]),
      ],
      [gitRepository("podinfo", [notReady("GitOperationFailed", "gone")])]
    );

    const platform = reconcilers.find((entry) => entry.name === "platform")!;
    const blocking = platform.findings.find(
      (finding) => finding.kind === "blocking"
    );
    expect(blocking?.kind === "blocking" && blocking.blocked.sort()).toEqual([
      "ingress",
      "monitoring",
    ]);

    // And the blocked one says what is actually wrong rather than only that
    // it is waiting.
    const monitoring = reconcilers.find(
      (entry) => entry.name === "monitoring"
    )!;
    const waiting = monitoring.findings.find(
      (finding) => finding.kind === "waiting"
    );
    expect(waiting?.kind === "waiting" && waiting.on).toBe("platform");
    expect(waiting?.kind === "waiting" && waiting.because).toContain(
      "Source artifact not found"
    );
  });

  /** A healthy dependency is not a finding: everything below it is proceeding. */
  it("says nothing about dependants of a reconciler that is working", () => {
    const { reconcilers } = picture(
      [
        kustomization("platform", {}, [ready("Applied")], REVISION),
        kustomization(
          "monitoring",
          { dependsOn: [{ name: "platform" }] },
          [ready("Applied")],
          REVISION
        ),
      ],
      [gitRepository("podinfo", [ready("stored artifact")], REVISION)]
    );
    expect(
      reconcilers.find((entry) => entry.name === "platform")!.findings
    ).toEqual([]);
  });
});

describe("a HelmRelease is a reconciler with a chart for a unit", () => {
  it("reads its chart, its version and its Helm source", () => {
    const release = object(
      "HelmRelease",
      "podinfo",
      {
        chart: {
          spec: {
            chart: "podinfo",
            version: "6.5.4",
            sourceRef: { kind: "HelmRepository", name: "podinfo" },
          },
        },
        interval: "10m",
      },
      {
        conditions: [ready("Helm install succeeded")],
        history: [{ chartVersion: "6.5.4" }],
      }
    );
    const { reconcilers } = fluxPicture(
      [],
      [release],
      [
        {
          kind: "HelmRepository",
          objects: [
            object(
              "HelmRepository",
              "podinfo",
              { url: "https://stefanprodan.github.io/podinfo" },
              {
                conditions: [ready("stored artifact")],
                artifact: { revision: "sha256:abc" },
              }
            ),
          ],
        },
      ]
    );

    expect(reconcilers[0].unit).toBe("podinfo 6.5.4");
    expect(reconcilers[0].sourceRef?.kind).toBe("HelmRepository");
    // It keeps no inventory: what it owns is in Helm's own storage, and a
    // number here would be invented.
    expect(reconcilers[0].objects).toBeNull();
    expect(reconcilerState(reconcilers[0]).tone).toBe("ok");
  });
});

describe("a source nobody applies", () => {
  it("is a finding, because nowhere else in the app could say so", () => {
    const { sources } = picture(
      [],
      [gitRepository("orphan", [ready("stored artifact")], REVISION)]
    );
    expect(sources[0].findings.map((finding) => finding.kind)).toEqual([
      "unused",
    ]);
  });
});

describe("revisions", () => {
  it("splits Flux's two spellings and shortens only the commit", () => {
    expect(readRevision(REVISION)).toEqual({
      raw: REVISION,
      ref: "master",
      commit: "eec06d1ea459af4cb4e10e806f8be7c7bd58b361",
    });
    expect(revisionText(readRevision(REVISION))).toBe("master@eec06d1");
    expect(revisionText(readRevision("master/eec06d1ea459"))).toBe(
      "master@eec06d1"
    );
    expect(revisionText(readRevision("6.5.4"))).toBe("6.5.4");
  });
});
