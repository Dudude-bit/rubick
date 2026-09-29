import { describe, expect, it } from "vitest";

import type { T } from "@/i18n/useT";
import type { DeploymentContainerInfo } from "@/generated/types";
import { templateContainersSection } from "./containers-section";

const t = ((section: string, key: string) =>
  `${section}.${key}`) as unknown as T;

const container = (
  name: string,
  image: string,
  phase: DeploymentContainerInfo["phase"] = "app"
) => ({ name, image, phase }) as unknown as DeploymentContainerInfo;

describe("templateContainersSection", () => {
  /** The image repository and tag are what changes between deploys; the state a running pod has does not belong here. */
  it("draws the template's declared containers, image apart from tag", () => {
    const section = templateContainersSection(
      {
        initContainers: [
          container("migrate", "registry.example/shop/migrate:1.4.0", "init"),
        ],
        containers: [container("app", "registry.example/shop/payments:2.21.0")],
      },
      t
    );
    expect(section.count).toBe(2);
    expect(section.body).toMatchObject({
      type: "containers",
      containers: [
        {
          name: "migrate",
          repository: "registry.example/shop/migrate",
          tag: "1.4.0",
          init: true,
        },
        {
          name: "app",
          repository: "registry.example/shop/payments",
          tag: "2.21.0",
          init: false,
        },
      ],
    });
  });
});
