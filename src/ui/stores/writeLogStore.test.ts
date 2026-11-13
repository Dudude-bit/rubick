import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useActivityPanelStore } from "./activityPanelStore";
import { recordWriteFailure, useWriteLog } from "./writeLogStore";

beforeEach(() => {
  useWriteLog.setState({ records: [] });
  useActivityPanelStore.setState({ open: false, tab: "ports", unseen: null });
});

describe("a failed write in the Activity log", () => {
  /**
   * The entry kept the dialog's "?" ("Restart pod x?") although nothing is
   * being asked any more. Fails if the question mark stays in the title.
   */
  it("is recorded as the action, not the question", () => {
    recordWriteFailure("Restart pod x?", new Error("boom"));
    expect(useWriteLog.getState().records[0].title).toBe("Restart pod x");
  });

  /**
   * The panel opened on Ports right after a failed write. Fails if the write
   * does not mark Writes as the tab with something new, or if opening it there
   * does not clear the mark.
   */
  it("marks Writes unseen until the panel opens on it", () => {
    recordWriteFailure("Delete pod x?", new Error("boom"));
    expect(useActivityPanelStore.getState().unseen).toBe("writes");
    useActivityPanelStore.getState().openOn("writes");
    expect(useActivityPanelStore.getState().unseen).toBeNull();
  });

  /** Fails if a write failing under an open Writes tab leaves it flagged as unseen. */
  it("is not unseen where the reader is already looking", () => {
    useActivityPanelStore.getState().openOn("writes");
    recordWriteFailure("Delete pod x?", new Error("boom"));
    expect(useActivityPanelStore.getState().unseen).toBeNull();
  });
});
