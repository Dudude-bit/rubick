import { screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { renderWithRouter } from "@/test/render";
import { RoutingMap, type MapNode } from "./routing-map";

const host = (id: string, tag: MapNode["tag"]): MapNode => ({
  id,
  label: `${id}.example.com`,
  tone: "ok",
  tag,
});

describe("a tag on the routing map", () => {
  /**
   * "TLS" and "TLS not checked" were one faint grey, told apart only by the
   * words — a TLS nobody checked looked like one that was fine. Fails if an
   * unknown tag is painted like a quiet one again.
   */
  it("marks a tag nobody could check apart from a quiet one", async () => {
    await renderWithRouter(
      <RoutingMap
        data={{
          columns: [
            {
              label: "Hosts",
              nodes: [
                host("shop", { text: "TLS", tone: "mute" }),
                host("blog", { text: "TLS not checked", tone: "unknown" }),
              ],
            },
          ],
          edges: [],
        }}
      />
    );

    const quiet = screen.getByText("TLS");
    const unchecked = screen.getByText("TLS not checked");
    expect(unchecked).toHaveClass("border-dashed");
    expect(quiet).not.toHaveClass("border-dashed");
  });
});
