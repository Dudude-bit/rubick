import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { VolumeRows } from "./volume-rows";
import type { PodVolumeInfo } from "@/generated/types";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const volume = (overrides: Partial<PodVolumeInfo>): PodVolumeInfo => ({
  name: "cfg",
  source: "configMap",
  refs: [{ kind: "ConfigMap", name: "app-config" }],
  mounts: [
    { container: "app", path: "/etc/config", readOnly: false, subPath: null },
  ],
  ...overrides,
});

describe("VolumeRows", () => {
  it("makes the object a volume draws from somewhere you can go", () => {
    /** The whole point of the block: `cfg` told the reader nothing about
     *  which ConfigMap it was, and the only way to find out was the YAML. */
    wrap(<VolumeRows volumes={[volume({})]} namespace="k8s-gui-test" />);

    expect(
      screen.getByRole("link", { name: "ConfigMap app-config" })
    ).toHaveAttribute("href", "/configmaps/k8s-gui-test/app-config");
  });

  it("offers one reference per source a projected volume names", () => {
    /** A projected volume is the one on every pod in the cluster, and it
     *  names several objects — collapsing it to the first would drop the
     *  Secret behind the ConfigMap. */
    wrap(
      <VolumeRows
        volumes={[
          volume({
            name: "kube-api-access",
            source: "projected",
            refs: [
              { kind: "ConfigMap", name: "kube-root-ca.crt" },
              { kind: "Secret", name: "sa-token" },
            ],
          }),
        ]}
        namespace="k8s-gui-test"
      />
    );

    expect(
      screen.getByRole("link", { name: "ConfigMap kube-root-ca.crt" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Secret sa-token" })
    ).toBeInTheDocument();
  });

  it("offers no reference for a source that names no object", () => {
    /** An emptyDir is storage, not a reference. A link here would claim the
     *  cluster has an object called `scratch`, which it does not. */
    wrap(
      <VolumeRows
        volumes={[volume({ name: "scratch", source: "emptyDir", refs: [] })]}
        namespace="k8s-gui-test"
      />
    );

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("emptyDir")).toBeInTheDocument();
  });

  it("says outright when nothing mounts the volume", () => {
    /** A volume declared and read by no container is a silent mistake: the
     *  pod runs, and the config somebody added is simply not there. */
    wrap(
      <VolumeRows volumes={[volume({ mounts: [] })]} namespace="k8s-gui-test" />
    );

    expect(screen.getByText("mounted by nothing")).toBeInTheDocument();
  });
});
