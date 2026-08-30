import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { ConnectionsPanel } from "./ConnectionsPanel";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ObjectRef, ResourceConnections } from "@/generated/types";

/**
 * A client, because the frame now asks a capability where this object came
 * from. With nothing installed it answers "nothing" — which is the state this
 * whole file's cluster is in and exactly what it must draw.
 */
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

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
  it("draws the kinds it never asked about", () => {
    /** The one group most likely to be dropped as noise. Without it, an
     *  absent Autoscaling section reads as "no HPA scales this Deployment",
     *  which is a claim the app cannot make: it has never read one. If this
     *  fails, the view has gone from honest to confident. */
    wrap(
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

  it("says a name was read off a pod spec rather than looked up", () => {
    /** A ConfigMap the app never listed and a ConfigMap that exists arrive
     *  here identical. Dropping the note is how a typo in a volume name
     *  starts looking like a healthy mount. */
    wrap(
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

  it("tells an answered nothing apart from a question never asked", () => {
    /** Three states, three screens. An empty page that only says "nothing"
     *  is indistinguishable from one that failed, so the empty one states
     *  what was read as well as what was found. */
    wrap(
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

    wrap(<ConnectionsPanel query={query({ isPending: true })} />);
    expect(
      screen.getByText("Reading what connects to this…")
    ).toBeInTheDocument();

    wrap(
      <ConnectionsPanel
        query={query({ error: new Error("connection refused") })}
      />
    );
    expect(screen.getByText("connection refused")).toBeInTheDocument();
  });
});
