import { screen } from "@testing-library/react";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { ContextInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

const { ClusterRoute } = await import("../route");

const t: T = (section, key, values) => translate("en", section, key, values);

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const context = (name: string): ContextInfo =>
  ({
    name,
    cluster: name,
    user: `${name}-user`,
    namespace: null,
    is_current: true,
    server: `https://${name}.example:6443`,
    exec_command: null,
    auth: { kind: "token", source: null },
  }) as unknown as ContextInfo;

beforeEach(() => {
  localStorage.clear();
  useClusterStore.setState({
    contexts: [context("acme-staging")],
    contextsKnown: true,
    currentContext: "acme-staging",
    isConnected: true,
    error: "Connection error: deadline has elapsed",
    errorContext: "acme-prod-eu",
  });
});

const openMissing = () =>
  renderWithRouter(<ClusterRoute />, {
    at: "/c/no-such-cluster",
    route: "/c/$cluster",
  });

describe("an address naming a cluster the kubeconfig does not list", () => {
  /** Dana's no-such-cluster page kept acme-staging's live sidebar, and its Events link renamed the tab while the page stayed the error. Fails if the connected cluster's sidebar or status bar comes back beside it. */
  it("draws no sidebar, tab or status bar of the connected cluster", async () => {
    await openMissing();
    expect(
      screen.getByText(
        t("empty", "clusterMissing", { cluster: "no-such-cluster" })
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Events/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      screen.queryByText(t("cluster", "didNotAnswer"))
    ).not.toBeInTheDocument();
  });

  /** Fails if the page stops offering the clusters the kubeconfig does list. */
  it("offers the clusters it can open instead", async () => {
    await openMissing();
    expect(screen.getByText("acme-staging")).toBeVisible();
  });
});
