import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import type { Picture } from "./data";

const monitor = (name: string): CustomResourceInfo => ({
  name,
  namespace: "shop",
  uid: `uid-${name}`,
  apiVersion: "monitoring.coreos.com/v1",
  kind: "ServiceMonitor",
  spec: { selector: { matchLabels: { app: name } }, endpoints: [] },
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

const PICTURE = {
  serviceMonitors: {
    state: "read",
    items: [monitor("payments-api"), monitor("web")],
  },
  podMonitors: { state: "read", items: [] },
  prometheuses: { state: "absent" },
  rules: { state: "absent" },
  services: { ok: true, items: [] },
  namespaces: { ok: true, items: [] },
  targets: { state: "notConnected" },
  alertRules: { state: "notConnected" },
} as unknown as Picture;

vi.mock("./data", async (original) => ({
  ...(await original<typeof import("./data")>()),
  usePicture: () => ({ data: PICTURE, error: null, refetch: () => {} }),
}));
vi.mock("./Detail", () => ({ Detail: () => null }));
vi.mock("../saved-connection", () => ({
  useSavedConnection: () => ({ data: null }),
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { renderWithRouter } from "@/test/render";
import Monitors from "./Monitors";

/**
 * The ladder was filtered to "payments" and listed one monitor; the file
 * listed every ServiceMonitor and PodMonitor of the cluster, so names the
 * sender never had on screen left with it. Fails if the section carries
 * rows the ladder does not list, or stops saying how they were narrowed.
 */
describe("what the Monitors ladder hands to Share", () => {
  it("carries the rows the filter left and says what it was", async () => {
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await renderWithRouter(
      <ScreenShareProvider>
        <Monitors />
        <Probe />
      </ScreenShareProvider>,
      { at: "/c/prod/integrations/prometheus" }
    );
    const whole = collect!().find(
      (section) => section.id === "prometheus-monitors-ladder"
    )!;
    expect(whole.count).toBe(2);
    expect(whole.caption ?? null).toBeNull();

    fireEvent.change(
      screen.getByLabelText("Filter monitors by name or namespace", {
        selector: "input",
      }),
      { target: { value: "payments" } }
    );
    const narrowed = collect!().find(
      (section) => section.id === "prometheus-monitors-ladder"
    )!;
    expect(narrowed.count).toBe(1);
    expect(narrowed.body).toMatchObject({
      type: "findings",
      items: [{ title: "payments-api" }],
    });
    expect(narrowed.caption).toBe(
      "Only the rows matching «payments», as the list was searched."
    );

    // The group chip narrows the same way and is named the same way.
    fireEvent.click(screen.getByRole("button", { name: /broken/ }));
    expect(
      collect!().find((one) => one.id === "prometheus-monitors-ladder")!.caption
    ).toBe(
      "Only the group «broken». Only the rows matching «payments», as the list was searched."
    );
  });
});
