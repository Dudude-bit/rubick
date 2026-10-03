import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { controllersSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what the Flux screen tells Share about its controllers", () => {
  /** A refused Deployment list came back as no controllers, and no section
   *  read as "every controller is ready". */
  it("marks the controllers unread when their list was refused", () => {
    const section = controllersSection(
      {
        controllers: [],
        unread: { key: "controllerLookupFailed", values: { why: "forbidden" } },
      },
      t
    );
    expect(section?.unread).toContain("forbidden");
  });

  it("marks the controllers unread while they are still being read", () => {
    expect(controllersSection(undefined, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  it("reports nothing when every controller was read and is ready", () => {
    expect(
      controllersSection(
        {
          controllers: [
            {
              name: "source-controller",
              namespace: "flux-system",
              image: null,
              ready: 1,
              desired: 1,
            },
          ],
          unread: null,
        },
        t
      )
    ).toBeNull();
  });
});
