import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what an Application tells a reader with no cluster access", () => {
  const sections = reportOf(
    {
      group: "argoproj.io",
      kind: "Application",
      namespace: "argocd",
      name: "storefront",
      spec: {
        project: "default",
        source: {
          repoURL: "https://git.example.com/acme/storefront",
          path: "deploy/prod",
          targetRevision: "main",
        },
        destination: {
          server: "https://kubernetes.default.svc",
          namespace: "shop",
        },
        syncPolicy: { automated: { selfHeal: true } },
      },
      status: {
        sync: { status: "OutOfSync" },
        health: { status: "Degraded", message: "1 of 2 replicas ready" },
        resources: [
          {
            group: "apps",
            kind: "Deployment",
            namespace: "shop",
            name: "storefront",
            status: "OutOfSync",
            health: { status: "Degraded" },
          },
        ],
      },
    },
    t
  );

  it("names the sync state, the health and the source", () => {
    const app = sections?.find(
      (section) => section.id === "argocd-application"
    );
    expect(app?.body.type).toBe("facts");
    if (app?.body.type !== "facts") throw new Error("expected facts");
    expect(app.body.rows[0]?.values[0]).toMatchObject({
      text: "out of sync · degraded",
      role: "err",
    });
    expect(
      app.body.rows.find((row) => row.label === "Source")?.values[0]?.text
    ).toContain("deploy/prod");
  });

  it("lists the one managed resource that is out of sync", () => {
    const resources = sections?.find(
      (section) => section.id === "argocd-resources"
    );
    expect(resources?.count).toBe(1);
    if (resources?.body.type !== "table") throw new Error("expected a table");
    expect(resources.body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "Deployment",
      "storefront",
      "OutOfSync",
      "Degraded",
    ]);
  });
});

describe("an Application that deploys to another cluster", () => {
  const report = (destination: Record<string, unknown>) =>
    reportOf(
      {
        group: "argoproj.io",
        kind: "Application",
        namespace: "argocd",
        name: "monitoring-spoke1",
        spec: { destination },
        status: {
          sync: { status: "Synced" },
          resources: [
            {
              group: "apps",
              kind: "Deployment",
              namespace: "monitoring",
              name: "prometheus-operator",
              status: "Synced",
            },
          ],
        },
      },
      t
    );
  const nameCell = (sections: ReturnType<typeof reportOf>) => {
    const table = sections?.find((one) => one.id === "argocd-resources")?.body;
    if (table?.type !== "table") throw new Error("expected a table");
    return table.rows[0]?.cells[1];
  };

  /**
   * The file drew a spoke's object as a reference to the reported cluster's
   * object of that name. Fails if such a row carries a reference, or the
   * destination stops naming the cluster.
   */
  it("names its objects without referring to this cluster's, and says where they are", () => {
    const sections = report({ name: "spoke1", namespace: "monitoring" });
    expect(nameCell(sections)).toMatchObject({ text: "prometheus-operator" });
    expect(nameCell(sections)?.ref).toBeUndefined();
    const facts = sections?.[0]?.body;
    if (facts?.type !== "facts") throw new Error("expected facts");
    expect(
      facts.rows.find((row) => row.label === "Destination")?.values[0]?.text
    ).toBe("monitoring on spoke1");
  });

  /** The control: an Application of this cluster refers to its objects. */
  it("refers to the objects of an Application that deploys here", () => {
    expect(
      nameCell(report({ server: "https://kubernetes.default.svc" }))?.ref
    ).toBeDefined();
  });
});

describe("what an AppProject tells a reader with no cluster access", () => {
  /** An empty `sourceRepos` was written as "-", which reads as "unset"; in
   *  Argo it refuses every repository, and the Projects tab says so. */
  it("says an empty list allows nothing, in the words the Projects tab uses", () => {
    const sections = reportOf(
      {
        group: "argoproj.io",
        kind: "AppProject",
        namespace: "argocd",
        name: "locked",
        spec: { sourceRepos: [], destinations: [] },
        status: {},
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    const [repos, destinations] = sections[0].body.rows;
    expect(repos.values[0].text).toBe("no repository allowed");
    expect(destinations.values[0].text).toBe("no destination allowed");
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a Certificate: that is cert-manager's kind, not Argo CD's", () => {
    const sections = reportOf(
      {
        group: "cert-manager.io",
        kind: "Certificate",
        namespace: "shop",
        name: "shop-tls",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
