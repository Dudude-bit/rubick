import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { mapNotes } from "./map-notes";

const t: T = (section, key, values) => translate("en", section, key, values);

const none = {
  edgeless: [],
  vendorUnread: [],
  routing: { gateways: null, classes: null },
  others: [],
  syncing: [],
};

describe("the lines above the map", () => {
  /**
   * A GatewayClass list that failed left every route and Gateway not
   * checked, and only the shared copy said why: the screen above the map,
   * built from its own list, left the line out. Fails if a failed verdict
   * list is not a warning in the one list the screen and Share both draw.
   */
  it("says above the map why routes and Gateways are not checked", () => {
    expect(mapNotes(none, t)).toEqual([]);
    expect(
      mapNotes(
        {
          ...none,
          routing: {
            gateways: null,
            classes: new Error("gatewayclasses is forbidden"),
          },
          syncing: ["Pod"],
        },
        t
      )
    ).toEqual([
      {
        text: "GatewayClass could not be read, so routes and Gateways are drawn not checked: gatewayclasses is forbidden",
        tone: "warn",
      },
      { text: t("topology", "stillListing", { kinds: "Pod" }), tone: "mute" },
    ]);
  });
});
