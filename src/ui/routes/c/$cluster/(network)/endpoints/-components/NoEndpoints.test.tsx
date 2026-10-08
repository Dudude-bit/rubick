import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import type { ChainStop, EndpointsInfo, ObjectRef } from "@/generated/types";
import type { ServiceBackingRead } from "@/hooks/useServiceBacking";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Backing } from "../../-components/service-backing";
import { NoEndpoints } from "./NoEndpoints";

const HELLO = {
  name: "hello-web",
  namespace: "lena-sandbox",
  subsets: [],
} as unknown as EndpointsInfo;

const at = (kind: string): ObjectRef => ({
  kind,
  name: "hello-web",
  namespace: "lena-sandbox",
  existence: "present",
  facts: null,
});

function drawn(stop: ChainStop) {
  const read: ServiceBackingRead = {
    published: () => ({ stop }) as ReturnType<ServiceBackingRead["published"]>,
    why: () => null,
  };
  render(
    <TooltipProvider>
      <Backing.Provider value={read}>
        <NoEndpoints endpoints={HELLO} />
      </Backing.Provider>
    </TooltipProvider>
  );
}

describe("the Endpoints list's empty row", () => {
  /** hello-web at zero read red "no endpoints" here while its Deployment read Idle; fails if the idle stop is ignored. */
  it("says an Endpoints object behind a workload scaled to zero is idle, not empty", () => {
    drawn({
      reason: "scaledToZero",
      service: at("Service"),
      selector: "app=hello-web",
      workloads: [at("Deployment")],
    });
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.queryByText("no endpoints")).toBeNull();
  });

  /** A selector matching nothing is still the fault this column exists to show. */
  it("keeps a Service that selects nothing red", () => {
    drawn({
      reason: "selectsNothing",
      service: at("Service"),
      selector: "app=hello-web",
    });
    expect(screen.getByText("no endpoints")).toHaveClass("text-err");
  });
});
