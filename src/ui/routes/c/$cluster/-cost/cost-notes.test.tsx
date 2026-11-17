import { describe, expect, it } from "vite-plus/test";

import {
  ScreenShareProvider,
  useScreenCaveats,
} from "@/components/share/screen-share";
import type { CostBasis } from "@/generated/types";
import { estimatePicture } from "@/lib/cost";
import { renderWithRouter } from "@/test/render";
import { CostNotes } from "./cost-notes";

const BASIS: CostBasis = {
  nodes: [],
  nodesUnread: null,
  heldUnread: null,
  namespaces: [],
  workloads: [],
  rest: null,
  waiting: 0,
  unread: [
    {
      namespace: "bank",
      code: "PERMISSION_DENIED",
      message: "pods is forbidden",
    },
  ],
  volumeBytes: 0,
  volumeCount: 0,
  unclaimed: [],
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "list",
};

describe("what the Cost page's notes put in the file Share writes", () => {
  /**
   * The page names a namespace whose pods were refused, and the file said
   * only that the total is at least: whoever reads it could not tell which
   * namespace is missing or why. Fails if a refusal shown is not shared.
   */
  it("names each namespace that could not be read, with the refusal", async () => {
    let said: ReturnType<typeof useScreenCaveats> = null;
    function Probe() {
      said = useScreenCaveats();
      return null;
    }
    const picture = estimatePicture(
      BASIS,
      { cpu: 0.04, memory: 0.005, storage: null, gpu: null, currency: "" },
      null
    );
    await renderWithRouter(
      <ScreenShareProvider>
        <CostNotes picture={picture} trouble={null} onPrices={() => {}} />
        <Probe />
      </ScreenShareProvider>,
      { at: "/c/prod/cost", route: "/c/$cluster/cost" }
    );
    const text = said!().join(" ");
    expect(text).toContain("bank");
    expect(text).toContain("pods is forbidden");
  });
});
