import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isReadDeadline,
  LIST_DEADLINE_SECONDS,
  SLOW_READ_MS,
} from "./read-deadline";

describe("the numbers both halves of a read apply", () => {
  const shared = JSON.parse(
    // Read rather than imported: these are the bytes `include_str!` pulls
    // into the Rust test, so the two tests look at one file.
    readFileSync(resolve(process.cwd(), "shared/read-deadlines.json"), "utf8")
  ) as { listDeadlineSeconds: number; slowReadSeconds: number };

  it("stops waiting after the number the shared file states", () => {
    expect(LIST_DEADLINE_SECONDS).toBe(shared.listDeadlineSeconds);
  });

  it("starts talking after the number the shared file states", () => {
    expect(SLOW_READ_MS).toBe(shared.slowReadSeconds * 1000);
  });
});

describe("telling a deadline from every other failure", () => {
  /**
   * The command wrapper puts its own words in front of the backend's, so the
   * marker is never at the start of what arrives. It is looked for, not
   * anchored.
   */
  it("reads the marker wherever the wrapper left it", () => {
    expect(
      isReadDeadline(
        new Error(
          "Tauri command 'list_pods' failed: READ_DEADLINE: the cluster did not answer within 60 s"
        )
      )
    ).toBe(true);
  });

  it("does not read a slow-sounding sentence as one", () => {
    expect(isReadDeadline(new Error("Operation timed out: dial tcp"))).toBe(
      false
    );
    expect(isReadDeadline(new Error("pods is forbidden"))).toBe(false);
    expect(isReadDeadline(undefined)).toBe(false);
  });
});
