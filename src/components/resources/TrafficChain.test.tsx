import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TrafficChain } from "./TrafficChain";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type {
  ChainStop,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const service: ObjectRef = {
  kind: "Service",
  name: "demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.43.0.9",
    externalName: null,
    selector: "app=demo",
    ports: [],
  },
};

const answered = (stops: ChainStop[]): ResourceConnections => ({
  subject: service,
  edges: [],
  stops,
  notLookedAt: [],
});

const query = (data: ResourceConnections | undefined, isPending = false) =>
  ({ data, error: null, isPending }) as ConnectionsQuery;

describe("TrafficChain", () => {
  it("gives each stop its own answer", () => {
    /** A view that draws all three the same way is a red dot. Each of these
     *  is a different repair — a name to fix, a selector to fix, a probe to
     *  fix — and the sentence is the whole product. */
    const said = (stop: ChainStop) => {
      const view = wrap(<TrafficChain query={query(answered([stop]))} />);
      const text = view.container.textContent ?? "";
      view.unmount();
      return text;
    };

    const missing = said({
      reason: "backendMissing",
      ingress: {
        kind: "Ingress",
        name: "ghost-demo",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: null,
      },
      service,
    });
    const empty = said({
      reason: "selectsNothing",
      service,
      selector: "app=tls-demo",
    });
    const unready = said({
      reason: "noneReady",
      service,
      selector: "app=unready-demo",
      pods: 2,
    });

    expect(missing).toContain("No Service named demo in this namespace");
    expect(empty).toContain("No pod carries app=tls-demo");
    expect(unready).toContain(
      "2 pods carry app=unready-demo, and none of them is ready"
    );
    expect(new Set([missing, empty, unready]).size).toBe(3);
  });

  it("spends one line where there is nothing to draw", () => {
    /** The whole feature has to be free on the pages that do not need it.
     *  A heading over an empty chain is two lines spent saying nothing is
     *  there. */
    wrap(
      <TrafficChain
        query={query({
          subject: {
            kind: "Deployment",
            name: "quiet-demo",
            namespace: "k8s-gui-test",
            existence: "present",
            facts: null,
          },
          edges: [],
          stops: [],
          notLookedAt: [],
        })}
      />
    );

    expect(
      screen.getByText(/No Service in this namespace selects these pods/)
    ).toBeInTheDocument();
    expect(screen.queryByText("How traffic gets here")).not.toBeInTheDocument();
  });

  it("does not draw a chain it has not read yet", () => {
    /** Loading is its own screen. A blank space where the chain will be
     *  reads as "nothing routes here", which is the one wrong answer. */
    wrap(<TrafficChain query={query(undefined, true)} />);
    expect(screen.getByText("Following the path in…")).toBeInTheDocument();
  });
});
