import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import type { Picture } from "./data";
import type { MonitorRow } from "./model";

vi.mock("@/lib/commands", () => ({
  commands: { getPrometheusConnection: () => Promise.resolve(null) },
}));

const { Detail } = await import("./Detail");

const prometheus = (spec: object): CustomResourceInfo => ({
  name: "kps",
  namespace: "monitoring",
  uid: "uid-kps",
  apiVersion: "monitoring.coreos.com/v1",
  kind: "Prometheus",
  spec,
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

const row: MonitorRow = {
  monitor: {
    kind: "ServiceMonitor",
    name: "web",
    namespace: "shop",
    uid: "uid-web",
    labels: { release: "kps" },
    selector: { matchLabels: { app: "web" } },
    namespaceSelector: null,
    endpoints: [],
  },
  selected: { kind: "notCounted" },
  pickedUp: { state: "judged", by: ["kps"] },
  scrape: { state: "notConnected" },
  findings: [],
  worst: null,
};

const picture = (spec: object) =>
  ({ prometheuses: { state: "read", items: [prometheus(spec)] } }) as Picture;

const draw = (spec: object) =>
  renderWithRouter(<Detail row={row} picture={picture(spec)} />, {
    at: "/c/prod",
    route: "/c/$cluster",
  });

describe("what the Monitors page says a Prometheus picks up", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * kube-prometheus-stack's default: monitors by release label, from every
   * namespace. The empty namespace selector was printed raw — "мониторы по
   * release=kps, в namespace по {}".
   */
  it("says an empty namespace selector means every namespace", async () => {
    useLocaleStore.setState({ choice: "ru" });
    await draw({
      serviceMonitorSelector: { matchLabels: { release: "kps" } },
      serviceMonitorNamespaceSelector: {},
    });
    expect(
      screen.getByText("мониторы по release=kps, во всех namespace")
    ).toBeInTheDocument();
    expect(screen.queryByText(/\{\}/)).toBeNull();
  });

  /**
   * An absent namespace selector is the Prometheus's own namespace only.
   * The line used to say nothing about namespaces, which reads as all.
   */
  it("says an absent namespace selector means its own namespace", async () => {
    useLocaleStore.setState({ choice: "ru" });
    await draw({ serviceMonitorSelector: { matchLabels: { release: "kps" } } });
    expect(
      screen.getByText("мониторы по release=kps, в своём namespace")
    ).toBeInTheDocument();
  });

  /** Would break if an empty monitor selector were printed as `{}` again. */
  it("says an empty monitor selector means every monitor", async () => {
    useLocaleStore.setState({ choice: "en" });
    await draw({
      serviceMonitorSelector: {},
      serviceMonitorNamespaceSelector: { matchLabels: { team: "shop" } },
    });
    expect(
      screen.getByText("every monitor, in namespaces matching team=shop")
    ).toBeInTheDocument();
  });

  /** `{}` is every monitor; where from is the namespace selector's to say. */
  it.each([
    [{}, "все мониторы во всех namespace"],
    [null, "все мониторы в своём namespace"],
  ])(
    "reads an empty monitor selector with namespaces %j",
    async (scope, words) => {
      useLocaleStore.setState({ choice: "ru" });
      await draw({
        serviceMonitorSelector: {},
        serviceMonitorNamespaceSelector: scope,
      });
      expect(screen.getByText(words)).toBeInTheDocument();
    }
  );
});
