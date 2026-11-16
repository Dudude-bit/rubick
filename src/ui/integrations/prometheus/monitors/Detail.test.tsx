import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import { en } from "@/i18n/catalogue";
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
      screen.getByText("мониторы по release=kps, во всех пространствах имён")
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
      screen.getByText("мониторы по release=kps, в своём пространстве имён")
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
    [{}, "все мониторы во всех пространствах имён"],
    [null, "все мониторы в своём пространстве имён"],
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

/**
 * "Nothing scrapes it" was claimed in red with scraping unchecked. Fails if
 * the not-picked-up line goes red while no Prometheus is connected.
 */
describe("the not-picked-up line", () => {
  const unpicked = {
    ...row,
    pickedUp: { state: "judged", by: [] },
  } as MonitorRow;
  it("is amber while scraping is unchecked", async () => {
    await renderWithRouter(
      <Detail
        row={unpicked}
        picture={picture({ serviceMonitorSelector: {} })}
      />,
      { at: "/c/prod", route: "/c/$cluster" }
    );
    expect(screen.getByText(en.monitors.notPickedUp).className).toContain(
      "text-warn"
    );
  });
});

/**
 * The step under "Picked up by" said "No Prometheus object in the cluster,
 * so nothing picks it up" in red. Fails if a cluster with no Prometheus
 * object gets the missing-CRD sentence, or a verdict about who reads it.
 */
describe("the pick-up step where no Prometheus object exists", () => {
  it("says pick-up is not judged, in the words for that reason", async () => {
    await renderWithRouter(
      <Detail
        row={{ ...row, pickedUp: { state: "notJudged", lacks: "object" } }}
        picture={{ prometheuses: { state: "read", items: [] } } as never}
      />,
      { at: "/c/prod", route: "/c/$cluster" }
    );
    expect(screen.getByText(en.monitors.notJudged)).toBeInTheDocument();
    expect(screen.getByText(en.monitors.noInstances)).toBeInTheDocument();
    expect(screen.queryByText(en.monitors.prometheusKindAbsent)).toBeNull();
  });
});

/**
 * "Picked up by" repeated the card's sentence word for word. Fails if the
 * sentence about a selector Kubernetes cannot build is drawn twice.
 */
describe("the pick-up step when the card above already says why it is unknown", () => {
  it("says the unevaluable selector once", async () => {
    const why = { kind: "unevaluable", prometheus: "kps" } as const;
    await renderWithRouter(
      <Detail
        row={{
          ...row,
          pickedUp: { state: "unknown", by: [], why },
          findings: [{ kind: "pickedUpUnknown", severity: "warn", why }],
        }}
        picture={picture({ serviceMonitorSelector: {} })}
      />,
      { at: "/c/prod", route: "/c/$cluster" }
    );
    const sentence = en.monitors.pickedUpUnevaluable.replace(
      "{prometheus}",
      "kps"
    );
    expect(document.body.textContent!.split(sentence)).toHaveLength(2);
  });
});

/**
 * "Picked up by" repeated the verdict's sentence, and the no-Prometheus
 * paragraph stood in the page note, the card and the Targets step. Fails if
 * either sentence is drawn by the detail more than the page note leaves to it.
 */
describe("a sentence the page already says", () => {
  const open = (over: Partial<MonitorRow>) =>
    renderWithRouter(
      <Detail
        row={{ ...row, ...over }}
        picture={picture({ serviceMonitorSelector: {} })}
      />,
      { at: "/c/prod", route: "/c/$cluster" }
    );

  it("says why nothing picks it up once, the step answering none", async () => {
    await open({
      pickedUp: { state: "judged", by: [] },
      findings: [{ kind: "notPickedUp", severity: "warn" }],
    } as Partial<MonitorRow>);
    expect(
      document.body.textContent!.split(en.monitors.notPickedUp)
    ).toHaveLength(2);
    expect(screen.getByText(en.empty.noneInline)).toBeInTheDocument();
  });

  it("leaves the no-Prometheus paragraph to the page note", async () => {
    await open({});
    expect(document.body.textContent).not.toContain(en.monitors.notConnected);
  });
});
