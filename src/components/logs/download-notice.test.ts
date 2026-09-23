import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { downloadNotice } from "./download-notice";

const t: T = (section, key, values) => translate("en", section, key, values);

const SAVED = [
  "/Users/Jane Doe/Downloads/web-a-app.log",
  "/Users/Jane Doe/Downloads/web-b-app (1).log",
];

describe("what a log Download says", () => {
  /** Two toasts in one tick left only the failure on screen: the reader thought nothing was saved and never saw where two files went. */
  it("names the saved files and the refused one in the same notice", () => {
    const notice = downloadNotice(
      SAVED,
      ["web-c/app: the node no longer has that log"],
      t
    );
    expect(notice?.title).toBe("2 of 3 logs saved");
    expect(notice?.variant).toBe("destructive");
    expect(notice?.description.split("\n")).toEqual([
      ...SAVED,
      "Not saved:",
      "web-c/app: the node no longer has that log",
    ]);
  });

  /** One path per line, so a path with a space in it is still one path. */
  it("lists every saved file on a line of its own when all were saved", () => {
    const notice = downloadNotice(SAVED, [], t);
    expect(notice).toEqual({
      title: "2 logs saved",
      description: SAVED.join("\n"),
    });
  });

  it("says the download failed when nothing was saved", () => {
    const notice = downloadNotice([], ["web-c/app: forbidden"], t);
    expect(notice).toMatchObject({
      title: "Download failed",
      variant: "destructive",
    });
  });
});
