import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import type { Picture } from "../monitors/data";

const rule = (name: string): CustomResourceInfo => ({
  name,
  namespace: "shop",
  uid: `uid-${name}`,
  apiVersion: "monitoring.coreos.com/v1",
  kind: "PrometheusRule",
  spec: {
    groups: [
      { name: "g", rules: [{ alert: `${name}-down`, expr: "up == 0" }] },
    ],
  },
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

const PICTURE = {
  serviceMonitors: { state: "absent" },
  podMonitors: { state: "absent" },
  prometheuses: { state: "absent" },
  rules: { state: "read", items: [rule("payments"), rule("web")] },
  services: { ok: true, items: [] },
  namespaces: { ok: true, items: [] },
  targets: { state: "notConnected" },
  alertRules: { state: "notConnected" },
} as unknown as Picture;

vi.mock("../monitors/data", async (original) => ({
  ...(await original<typeof import("../monitors/data")>()),
  usePicture: () => ({ data: PICTURE, error: null, refetch: () => {} }),
}));
vi.mock("../saved-connection", () => ({
  useSavedConnection: () => ({ data: null }),
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { renderWithRouter } from "@/test/render";
import Alerts from "./Alerts";

/**
 * The ladder was filtered to "payments" and listed one rule object; the
 * file listed every PrometheusRule of the cluster that was not quiet.
 * Fails if the section carries rows the ladder does not list, or stops
 * saying how they were narrowed.
 */
describe("what the Alerts ladder hands to Share", () => {
  it("carries the rows the filter left and says what it was", async () => {
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await renderWithRouter(
      <ScreenShareProvider>
        <Alerts />
        <Probe />
      </ScreenShareProvider>,
      { at: "/c/prod/integrations/prometheus?tab=alerts" }
    );
    const section = () =>
      collect!().find((one) => one.id === "prometheus-alerts")!;
    expect(section().count).toBe(2);
    expect(section().caption ?? null).toBeNull();

    fireEvent.change(
      screen.getByLabelText(en.alerts.filterLabel, { selector: "input" }),
      { target: { value: "payments" } }
    );
    expect(section().count).toBe(1);
    expect(section().body).toMatchObject({
      type: "findings",
      items: [{ title: "payments" }],
    });
    expect(section().caption).toBe(
      "Only the rows matching «payments», as the list was searched."
    );

    // The group chip narrows the same way and is named the same way.
    fireEvent.click(screen.getByRole("button", { name: /not checked/ }));
    expect(section().caption).toBe(
      "Only the group «not checked». Only the rows matching «payments», as the list was searched."
    );
  });
});
