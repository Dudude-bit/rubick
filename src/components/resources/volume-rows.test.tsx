import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { VolumeRows } from "./volume-rows";
import type { PodVolumeInfo, VolumeMountInfo } from "@/generated/types";

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

const show = (volumes: PodVolumeInfo[], containerCount = 1) =>
  wrap(
    <VolumeRows
      volumes={volumes}
      namespace="k8s-gui-test"
      containerCount={containerCount}
    />
  );

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

const mount = (
  container: string,
  overrides: Partial<VolumeMountInfo> = {}
): VolumeMountInfo => ({
  container,
  path: SA,
  readOnly: true,
  subPath: null,
  ...overrides,
});

describe("VolumeRows", () => {
  it("makes the object a volume draws from somewhere you can go", () => {
    /** The whole point of the block: `cfg` told the reader nothing about
     *  which ConfigMap it was, and the only way to find out was the YAML. */
    show([volume({})]);

    expect(
      screen.getByRole("link", { name: "ConfigMap app-config" })
    ).toHaveAttribute("href", "/configmaps/k8s-gui-test/app-config");
  });

  it("offers one reference per source a projected volume names", () => {
    /** A projected volume is the one on every pod in the cluster, and it
     *  names several objects — collapsing it to the first would drop the
     *  Secret behind the ConfigMap. */
    show([
      volume({
        name: "kube-api-access",
        source: "projected",
        refs: [
          { kind: "ConfigMap", name: "kube-root-ca.crt" },
          { kind: "Secret", name: "sa-token" },
        ],
      }),
    ]);

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
    show([volume({ name: "scratch", source: "emptyDir", refs: [] })]);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("emptyDir")).toBeInTheDocument();
  });

  it("says outright when nothing mounts the volume", () => {
    /** A volume declared and read by no container is a silent mistake: the
     *  pod runs, and the config somebody added is simply not there. */
    show([volume({ mounts: [] })]);

    expect(screen.getByText("mounted by nothing")).toBeInTheDocument();
  });

  it("says the path once where two containers mount it the same way", () => {
    /** The reported case. Printed per container, the longest path in
     *  Kubernetes appeared twice in one cell and the container names — the
     *  only thing that differed — were buried in the middle of it. */
    show([volume({ mounts: [mount("ingest"), mount("web")] })], 2);

    expect(screen.getAllByText(SA)).toHaveLength(1);
    expect(screen.getByText("all containers")).toBeInTheDocument();
  });

  it("names the containers where only some of them mount it", () => {
    /** "all containers" is a claim about the pod's whole roster. Where a
     *  volume reaches one of the two, which one is the whole answer. */
    show([volume({ mounts: [mount("ingest", { path: "/etc/app" })] })], 2);

    expect(screen.getByText("ingest")).toBeInTheDocument();
  });

  it("keeps both mounts where the same volume is mounted two ways", () => {
    /** Grouping must key on what the line says, not on the volume: an init
     *  container writing a path the app container only reads is exactly the
     *  fact a reader comes to this column for. */
    const { container } = show(
      [
        volume({
          mounts: [
            mount("seed", { path: "/etc/app", readOnly: false }),
            mount("app", { path: "/etc/app" }),
          ],
        }),
      ],
      2
    );

    expect(container.textContent).toContain("seed · /etc/app");
    expect(container.textContent).toContain("app · /etc/app, read-only");
  });

  it("summarises rather than lists when the whole pod mounts it", () => {
    /** Three containers naming the same service-account path is a roster
     *  nobody reads; that every container mounts it is the one fact in it. */
    show(
      [volume({ mounts: ["prepare", "proxy", "app"].map((c) => mount(c)) })],
      3
    );

    expect(screen.getByText("all containers")).toBeInTheDocument();
    expect(screen.queryByText(/prepare/)).not.toBeInTheDocument();
  });

  it("leaves the container out where the pod has only one", () => {
    /** A one-container pod has nothing to tell apart, so the name is the
     *  same word down the column and the path is what the reader wants. */
    const { container } = show([volume({ mounts: [mount("app")] })], 1);

    expect(screen.queryByText("app")).not.toBeInTheDocument();
    expect(container.textContent).toContain(`${SA}, read-only`);
  });

  it("keeps a subPath out of the path it is not part of", () => {
    /** Glued on with a slash, `/etc/app` + `app.conf` was indistinguishable
     *  from a mount at `/etc/app/app.conf` — a different mount entirely. */
    const { container } = show([
      volume({
        mounts: [
          mount("app", {
            path: "/etc/app",
            readOnly: false,
            subPath: "app.conf",
          }),
        ],
      }),
    ]);

    expect(screen.getByText("/etc/app")).toBeInTheDocument();
    expect(container.textContent).toContain("/etc/app from app.conf");
  });
});
