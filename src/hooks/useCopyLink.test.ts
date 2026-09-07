import { describe, expect, it } from "vitest";

import { claimedByTarget, isCopyLinkKey } from "./useCopyLink";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("isCopyLinkKey", () => {
  /** Command on macOS and Control elsewhere are the same logical key; either must work. */
  it("accepts mod+shift+c with either modifier and nothing else", () => {
    expect(
      isCopyLinkKey(key({ metaKey: true, shiftKey: true, key: "C" }))
    ).toBe(true);
    expect(
      isCopyLinkKey(key({ ctrlKey: true, shiftKey: true, key: "c" }))
    ).toBe(true);
    expect(isCopyLinkKey(key({ ctrlKey: true, key: "c" }))).toBe(false);
    expect(
      isCopyLinkKey(
        key({ ctrlKey: true, shiftKey: true, altKey: true, key: "c" })
      )
    ).toBe(false);
  });
});

describe("claimedByTarget", () => {
  /** Ctrl+Shift+C in a terminal is "copy the selection"; stealing it would break every shell. */
  it("leaves the keys to a terminal and to text fields", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const inner = document.createElement("span");
    term.appendChild(inner);
    expect(claimedByTarget(inner)).toBe(true);
    expect(claimedByTarget(document.createElement("input"))).toBe(true);
    expect(claimedByTarget(document.createElement("textarea"))).toBe(true);
    expect(claimedByTarget(document.createElement("div"))).toBe(false);
    expect(claimedByTarget(null)).toBe(false);
  });
});
