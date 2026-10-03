import { describe, expect, it } from "vitest";

import { podToShow } from "./pod-selection";

const pods = (...names: string[]) => names.map((name) => ({ name }));

describe("the pod whose logs are shown", () => {
  it("keeps the reader's choice while that pod is there", () => {
    expect(podToShow(pods("a", "b", "c"), "b")).toBe("b");
  });

  it("takes the first when nothing is chosen yet", () => {
    expect(podToShow(pods("a", "b"), null)).toBe("a");
  });

  /**
   * The bug this exists for: walk from one Deployment to another and the
   * chosen name belongs to a pod the new list does not have. Keeping it
   * left the Logs tab empty with no way back.
   */
  it("replaces a choice the list no longer has", () => {
    expect(podToShow(pods("new-1", "new-2"), "old-7")).toBe("new-1");
  });

  it("replaces a pod that was rolled away", () => {
    expect(podToShow(pods("web-2"), "web-1")).toBe("web-2");
  });

  it("has nothing to show when there are no pods", () => {
    expect(podToShow([], "web-1")).toBeNull();
    expect(podToShow([], null)).toBeNull();
  });
});
