import { createElement, Fragment } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { resolveSource } from "./peek-sources";

describe("the none word in a peek", () => {
  const t = ((_section: string, key: string) => key) as never;
  const target = { kind: "Ingress", name: "web", namespace: "shop" };
  const ingress = {
    name: "web",
    namespace: "shop",
    className: null,
    rules: [],
    defaultBackend: null,
    loadBalancerIps: [],
    tlsHosts: [],
    tlsConfigs: [],
    hasCatchAllTls: false,
    labels: {},
    annotations: {},
    createdAt: null,
  };

  /** The Ingress peek said "Address None" while its list said "none". */
  it("draws an empty Ingress address as the lists' lowercase none", () => {
    const items = resolveSource(target).summarise(ingress, target, t).groups[0]
      .items;
    const drawn = (label: string) =>
      render(
        createElement(
          Fragment,
          null,
          items.find((item) => item.label === label)?.value
        )
      ).container.textContent;
    expect(drawn("address")).toBe("none");
  });
});
