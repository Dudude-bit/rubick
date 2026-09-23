import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/generated/commands", () => ({
  getPod: vi.fn(() =>
    Promise.reject({
      code: "LIST_UNREAD",
      message:
        "Could not read the Pod list, so whether web is there is unknown: pods is forbidden",
    })
  ),
}));

import { commands } from "./commands";
import { ERROR_CODES, errorCode } from "./error-utils";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";

describe("an error's code across the IPC boundary", () => {
  /**
   * Would send the frontend back to reading the sentence: the backend now
   * says what an error is, and the wrapper every call goes through has to
   * keep that on what it throws.
   */
  it("keeps the backend's code on the error a caller catches", async () => {
    const thrown = await commands
      .getPod("web", "shop")
      .catch((error: unknown) => error);
    // Read from the sentence this would be a refusal; the backend says what
    // it is.
    expect(errorCode(thrown)).toBe(ERROR_CODES.LIST_UNREAD);
    expect((thrown as Error).message).toBe(
      "Tauri command 'getPod' failed: Could not read the Pod list, so whether web is there is unknown: pods is forbidden"
    );
  });

  /** A page that re-throws `new Error(message, { cause })` keeps it a level down. */
  it("reads the code through a re-thrown error's cause", () => {
    const original = Object.assign(new Error("x"), { code: "LIST_UNREAD" });
    const rethrown = new Error("y", { cause: original });
    expect(errorCode(rethrown)).toBe(ERROR_CODES.LIST_UNREAD);
  });

  /**
   * "No previous run … not found" and "Could not read the Service list, so
   * whether web is there is unknown" both said "not found" to a substring,
   * and the page drew the object as deleted.
   */
  it("calls an object gone only when the backend says so", () => {
    const noPreviousRun = Object.assign(
      new Error(
        "No previous run: app has not restarted — previous terminated container not found"
      ),
      { code: "NO_PREVIOUS_RUN" }
    );
    expect(isResourceNotFoundError(noPreviousRun)).toBe(false);
    const gone = Object.assign(new Error("Resource not found: Pod/web"), {
      code: "NOT_FOUND",
    });
    expect(isResourceNotFoundError(gone)).toBe(true);
  });

  /** A code Rust sends that this table does not know reads as unknown here. */
  it("knows every code the backend sends", () => {
    const shared = JSON.parse(
      readFileSync(resolve(process.cwd(), "shared/error-codes.json"), "utf8")
    ) as { codes: string[] };
    const here = new Set<string>(Object.values(ERROR_CODES));
    here.delete(ERROR_CODES.UNKNOWN);
    expect([...here].sort()).toEqual([...shared.codes].sort());
  });
});
