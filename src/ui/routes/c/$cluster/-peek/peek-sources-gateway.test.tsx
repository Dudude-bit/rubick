import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import type { ConditionInfo, GatewayInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { GATEWAY_SOURCES } from "./peek-sources-gateway";

const t: T = (section, key, values) => translate("en", section, key, values);

const said = (
  type: string,
  status: string,
  reason: string,
  message: string | null = null
): ConditionInfo => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: null,
});

const gateway = (conditions: ConditionInfo[]): GatewayInfo => ({
  uid: "",
  name: "bad-gw",
  namespace: "traefik",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "traefik",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [
    {
      name: "odd",
      port: 9999,
      protocol: "HTTP",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: "All",
      attachedRoutes: 0,
      conditions: [
        said(
          "Accepted",
          "False",
          "PortUnavailable",
          "no matching entryPoint for port 9999"
        ),
      ],
      fromListenerSet: null,
    },
  ],
  addresses: [],
  conditions,
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
});

const lead = (conditions: ConditionInfo[]) => {
  const summary = GATEWAY_SOURCES.Gateway!.summarise(
    gateway(conditions),
    { kind: "Gateway", name: "bad-gw", namespace: "traefik" },
    t
  );
  render(<>{summary.lead}</>);
};

describe("the Gateway peek against the Gateway page", () => {
  /**
   * The peek of bad-gw said "ListenersNotValid" and nothing of why, while
   * its page now leads with the controller's answer and the listener it
   * refused. Fails if the peek stops saying what the page says, or says it
   * of a Gateway that is programmed.
   */
  it("leads with the controller's answer and the listener under it", () => {
    lead([
      said(
        "Accepted",
        "False",
        "ListenersNotValid",
        "All Listeners must be valid"
      ),
    ]);
    expect(
      screen.getByText("The controller refuses this Gateway")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /^ListenersNotValid: All Listeners must be valid\. Listener odd: PortUnavailable: no matching entryPoint for port 9999\. Nothing behind it serves/
      )
    ).toBeInTheDocument();
  });

  it("leads with nothing over a programmed Gateway", () => {
    lead([said("Programmed", "True", "Programmed")]);
    expect(
      screen.queryByText("The controller refuses this Gateway")
    ).toBeNull();
  });
});
