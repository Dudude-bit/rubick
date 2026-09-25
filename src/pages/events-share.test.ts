import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { eventsFiltersSection } from "./events-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("the filters a shared report of Events carries", () => {
  /** A reader opening the file must see the same narrowed feed the sender
   *  did; deleting a branch here silently widens what the file claims. */
  it("names the window only in stories view, and the search only when typed", () => {
    const stories = eventsFiltersSection("stories", "1h", "all", "", "500", t);
    expect(stories.body).toMatchObject({
      type: "facts",
      rows: [
        { label: "View" },
        { label: "Window" },
        { label: "Events fetched" },
      ],
    });

    const list = eventsFiltersSection(
      "list",
      "1h",
      "Warning",
      "crash",
      "all",
      t
    );
    expect(list.body).toMatchObject({
      type: "facts",
      rows: [
        { label: "View" },
        { label: "Event type", values: [{ text: "Warning" }] },
        { label: "Filter events…", values: [{ text: "crash" }] },
        { label: "Events fetched", values: [{ text: "No limit" }] },
      ],
    });
  });
});
