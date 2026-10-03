import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HelmInstallDialog } from "./HelmInstallDialog";
import type { HelmChartSearchResult } from "@/generated/types";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

const chart: HelmChartSearchResult = {
  name: "nginx",
  version: "1.0.0",
  appVersion: "1.25",
  description: "web server",
};

const dialog = () => (
  <HelmInstallDialog
    chart={chart}
    onClose={() => {}}
    namespaces={["default"]}
    releaseName="web"
    onReleaseNameChange={() => {}}
    namespace="default"
    onNamespaceChange={() => {}}
    version=""
    onVersionChange={() => {}}
    values=""
    onValuesChange={() => {}}
    createNamespace={false}
    onCreateNamespaceChange={() => {}}
    wait={false}
    onWaitChange={() => {}}
    onInstall={() => {}}
    isInstalling={false}
  />
);

const installButton = () => screen.getByRole("button", { name: /^install$/i });

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: PROD, isConnected: true });
});

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("installing a chart on critical infrastructure", () => {
  /**
   * Installing creates a whole release; on the marked cluster it took no
   * confirmation at all while uninstall and rollback of the same release did,
   * so the gate has to reach install too.
   */
  it("holds the install button until the cluster's name is typed", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    render(dialog());

    expect(screen.getByRole("alert")).toHaveTextContent(PROD);
    expect(installButton()).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(installButton()).toBeEnabled();
  });

  it("asks nothing of a cluster nobody marked", () => {
    render(dialog());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(installButton()).toBeEnabled();
  });
});
