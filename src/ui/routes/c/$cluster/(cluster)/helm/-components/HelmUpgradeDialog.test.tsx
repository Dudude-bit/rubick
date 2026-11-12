import { beforeEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { HelmUpgradeDialog } from "./HelmUpgradeDialog";
import type { HelmRelease } from "@/generated/types";
import { translate } from "@/i18n";
import { WITHHELD_MARKER } from "@/lib/withheld";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const web: HelmRelease = {
  name: "web",
  namespace: "team-a",
  revision: 3,
  status: "deployed",
  chart: "nginx-1.0.0",
  appVersion: "1.25",
  updated: "2026-09-05T10:00:00Z",
  source: "native",
  suspended: null,
  sourceRef: null,
  unreadable: null,
};

const dialog = (values: string) => (
  <HelmUpgradeDialog
    release={web}
    onClose={() => {}}
    chart="bitnami/nginx"
    onChartChange={() => {}}
    version=""
    onVersionChange={() => {}}
    values={values}
    onValuesChange={() => {}}
    wait={false}
    onWaitChange={() => {}}
    onUpgrade={() => {}}
    isUpgrading={false}
  />
);

const upgradeButton = () => screen.getByRole("button", { name: /^upgrade$/i });

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

describe("upgrading with values copied off the Values tab", () => {
  /**
   * The Values tab draws a placeholder where it withheld a private key, with
   * Copy. Pasted here and sent, helm stored the placeholder as the key.
   * Fails if Upgrade is offered for such values, or the reason is not given
   * before the reader confirms.
   */
  it("refuses values that still hold the placeholder, and says what to do", () => {
    const copied = `password: hunter2\nprivateKey: '${WITHHELD_MARKER}'\n`;
    const { unmount } = render(dialog(copied));

    expect(upgradeButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      /an upgrade would store the placeholder as the key\. Write the key itself there, or clear the values: with none given, helm keeps the ones the release has\./
    );
    unmount();

    render(dialog("password: hunter2\n"));
    expect(upgradeButton()).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  /** No values at all is how helm is left the ones the release has. */
  it("offers an upgrade with no values", () => {
    render(dialog(""));
    expect(upgradeButton()).toBeEnabled();
  });

  /** Fails if the reason is English in the Russian UI. */
  it("has the reason in Russian", () => {
    expect(translate("ru", "action", "helmUpgradeCarriesWithheld")).toMatch(
      /^В этих значениях стоит заглушка/
    );
    expect(translate("ru", "action", "helmInstallCarriesWithheld")).toMatch(
      /^В этих значениях стоит заглушка/
    );
  });
});
