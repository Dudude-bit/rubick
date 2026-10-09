import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { ProxyControllerTab } from "./proxy-controller";

const words = {
  reading: "reading",
  title: "The controller",
  description: "what runs it",
  claimsNoClass: "claims no class",
};

describe("a proxy's controller tab", () => {
  /**
   * nginx's tab linked `kind="Deployment"` whatever it had found, so an
   * ingress-nginx installed as a DaemonSet sent the reader to a Deployment
   * that does not exist.
   */
  it("links the workload as the kind it really is", async () => {
    await renderWithRouter(
      <ProxyControllerTab
        controller={{
          workload: {
            kind: "DaemonSet",
            name: "ingress-nginx-controller",
            namespace: "ingress-nginx",
            image: null,
            ready: 3,
            desired: 3,
          },
          args: [],
          problem: null,
        }}
        classes={[]}
        words={words}
      />,
      { at: "/c/prod", route: "/c/$cluster" }
    );
    expect(
      screen.getByRole("link", { name: /ingress-nginx-controller/ })
    ).toHaveAttribute(
      "href",
      "/c/prod/daemonsets/ingress-nginx/ingress-nginx-controller"
    );
    expect(screen.getByText("claims no class")).toBeInTheDocument();
  });
});
