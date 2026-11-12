import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  currentConnection,
  forgetRefusals,
  noteRefusal,
  useRefusedAt,
} from "@/lib/refusals";

/** `error` under `layers` errors, each the cause of the next, as a read's rethrow wraps it. */
function wrapped(error: unknown, layers: number): unknown {
  let at = error;
  for (let layer = 0; layer < layers; layer++)
    at = new Error("read failed", { cause: at });
  return at;
}

describe("when the refusal a screen holds was said", () => {
  beforeEach(() => forgetRefusals());

  /**
   * A read rethrows the cluster's refusal inside its own error, so the kept
   * refusal is looked for among an error's causes. The look ends four deep,
   * which is all that ends it on a chain of causes that loops. Fails if a
   * wrapped refusal loses its time, or the look goes on past its end.
   */
  it("is found through the errors that wrap the refusal, four deep and no further", () => {
    const refusal = { code: "PERMISSION_DENIED", message: "pods is forbidden" };
    noteRefusal("listPods [null]", refusal, currentConnection());
    const saidAt = (error: unknown) =>
      renderHook(() => useRefusedAt(error)).result.current;

    expect(saidAt(wrapped(refusal, 3))).toEqual(expect.any(Number));
    expect(saidAt(wrapped(refusal, 4))).toBeNull();
    expect(saidAt(new Error("timed out"))).toBeNull();
  });
});
