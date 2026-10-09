import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { ConnectionsPanel } from "./ConnectionsPanel";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ObjectRef, ResourceConnections } from "@/generated/types";

/**
 * Inside a query client, because the frame now asks a capability where this
 * object came from. With nothing installed it answers "nothing", which is the
 * state this whole file's cluster is in and exactly what it must draw.
 */
const wrap = (ui: ReactElement) =>
  renderWithRouter(ui, {
    at: "/c/prod/deployments/k8s-gui-test/mounts-demo",
    route: "/c/$cluster/$resource/$namespace/$name",
  });

const subject: ObjectRef = {
  kind: "Deployment",
  name: "mounts-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const query = (
  state: Partial<{
    data: ResourceConnections;
    error: Error | null;
    isPending: boolean;
  }>
) =>
  ({
    data: undefined,
    error: null,
    isPending: false,
    ...state,
  }) as ConnectionsQuery;

const answered = (
  parts: Partial<Omit<ResourceConnections, "subject">>
): ResourceConnections => ({
  subject,
  edges: [],
  stops: [],
  published: [],
  notLookedAt: [],
  ...parts,
});

describe("ConnectionsPanel", () => {
  it("draws the kinds it never asked about", async () => {
    /** The one group most likely to be dropped as noise. Without it, an
     *  absent Autoscaling section reads as "no HPA scales this Deployment",
     *  which is a claim the app cannot make: it has never read one. If this
     *  fails, the view has gone from honest to confident. */
    await wrap(
      <ConnectionsPanel
        query={query({
          data: answered({
            notLookedAt: [
              {
                kind: "HorizontalPodAutoscaler",
                why: {
                  says: "unanswered",
                  version: "autoscaling/v2",
                  said: "404",
                },
              },
              {
                kind: "PodDisruptionBudget",
                why: { says: "unanswered", version: "policy/v1", said: "403" },
              },
            ],
          }),
        })}
      />
    );

    expect(screen.getByText("Not looked at")).toBeInTheDocument();
    expect(screen.getByText("Autoscaling")).toBeInTheDocument();
    expect(screen.getByText("Disruption budget")).toBeInTheDocument();
    expect(
      screen.getByText(
        /asked for autoscaling\/v2 and the cluster did not answer/
      )
    ).toBeInTheDocument();
  });

  it("says a name was read off a pod spec rather than looked up", async () => {
    /** A ConfigMap the app never listed and a ConfigMap that exists arrive
     *  here identical. Dropping the note is how a typo in a volume name
     *  starts looking like a healthy mount. */
    await wrap(
      <ConnectionsPanel
        query={query({
          data: answered({
            edges: [
              {
                from: subject,
                to: {
                  kind: "ConfigMap",
                  name: "demo-config",
                  namespace: "k8s-gui-test",
                  existence: "notChecked",
                  facts: null,
                },
                relation: {
                  verb: "uses",
                  usages: [
                    {
                      how: "mount",
                      container: "app",
                      path: "/etc/app",
                      readOnly: false,
                      subPath: null,
                      volume: "config",
                      projected: false,
                    },
                  ],
                },
              },
            ],
          }),
        })}
      />
    );

    expect(screen.getByText("mounted at /etc/app")).toBeInTheDocument();
    expect(screen.getByText("not checked")).toBeInTheDocument();
  });

  it("tells an answered nothing apart from a question never asked", async () => {
    /** Three states, three screens. An empty page that only says "nothing"
     *  is indistinguishable from one that failed, so the empty one states
     *  what was read as well as what was found. */
    await wrap(
      <ConnectionsPanel
        query={query({
          data: {
            subject: {
              kind: "ConfigMap",
              name: "lonely-demo",
              namespace: "k8s-gui-test",
              existence: "notChecked",
              facts: null,
            },
            edges: [],
            stops: [],
            published: [],
            notLookedAt: [],
          },
        })}
      />
    );
    expect(
      screen.getByText(/Nothing in k8s-gui-test states an edge/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/was read; none of them names it/)
    ).toBeInTheDocument();

    await wrap(<ConnectionsPanel query={query({ isPending: true })} />);
    expect(
      screen.getByText("Reading what connects to this…")
    ).toBeInTheDocument();

    await wrap(
      <ConnectionsPanel
        query={query({ error: new Error("connection refused") })}
      />
    );
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
  });

  /** checkout-worker sat on the Secret's tab as an ordinary user while the
   *  key it reads was not there; this fails if the mark is not drawn. */
  it("marks a user that reads a key the Secret does not hold", async () => {
    const secret: ObjectRef = {
      kind: "Secret",
      name: "checkout-db",
      namespace: "team-checkout",
      existence: "notChecked",
      facts: null,
    };
    await wrap(
      <ConnectionsPanel
        query={query({
          data: {
            subject: secret,
            edges: [
              {
                from: {
                  kind: "Deployment",
                  name: "checkout-worker",
                  namespace: "team-checkout",
                  existence: "present",
                  facts: null,
                },
                to: secret,
                relation: {
                  verb: "uses",
                  usages: [
                    {
                      how: "env",
                      container: "worker",
                      name: "DB_PASSWORD",
                      key: "DB_PASSWORD",
                      optional: false,
                      keyPresent: false,
                    },
                  ],
                },
              },
            ],
            stops: [],
            published: [],
            notLookedAt: [],
          },
        })}
      />
    );
    const mark = screen.getByText("key DB_PASSWORD is not in this Secret");
    expect(mark).toHaveClass("text-err");
  });

  /**
   * An owner reference names a group. Read by the kind alone, a pod made by
   * a namesake of a built-in controller linked to the built-in's page.
   */
  it("opens an owner by its group and draws a namesake as text while its CRD is unknown", async () => {
    const pod: ObjectRef = { ...subject, kind: "Pod", name: "web-0" };
    const owner = (group: string, name: string): ObjectRef => ({
      ...subject,
      kind: "StatefulSet",
      name,
      group,
      existence: "notChecked",
    });
    await wrap(
      <ConnectionsPanel
        query={query({
          data: {
            ...answered({
              edges: [
                {
                  from: owner("apps", "db"),
                  to: pod,
                  relation: { verb: "owns", controller: true },
                },
                {
                  from: owner("apps.kruise.io", "kruise-db"),
                  to: pod,
                  relation: { verb: "owns", controller: false },
                },
              ],
            }),
            subject: pod,
          },
        })}
      />
    );
    expect(
      await screen.findByRole("link", { name: "StatefulSet db" })
    ).toHaveAttribute("href", "/c/prod/statefulsets/k8s-gui-test/db");
    expect(
      screen.queryByRole("link", { name: "StatefulSet kruise-db" })
    ).toBeNull();
    expect(screen.getByText("StatefulSet kruise-db")).toBeInTheDocument();
  });
});
