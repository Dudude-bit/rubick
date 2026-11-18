import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { TopologyStore } from "../-map/useTopology";
import { shareSaid } from "./topology-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a shared map says of how much of it was read", () => {
  /**
   * A share taken after the rail's first batch and before the map was
   * whole handed over a few groups, or none, as the cluster. Fails if a
   * map still being drawn is not marked partial, one still opening is not
   * unread, or a map drawn whole carries either.
   */
  it("marks a map still being drawn as partial, and one still opening as unread", () => {
    const store = new TopologyStore();
    const said = () => shareSaid(store.snapshot(), ["a caveat"], t);
    expect(said()).toEqual({
      unread: t("topology", "shareStillOpening"),
      notes: ["a caveat"],
    });
    store.apply([{ is: "kinds", kinds: [] }]);
    expect(said()).toEqual({
      unread: null,
      notes: [t("topology", "shareStillDrawing"), "a caveat"],
    });
    store.ready();
    expect(said()).toEqual({ unread: null, notes: ["a caveat"] });
  });
});
