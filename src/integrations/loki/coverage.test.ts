/**
 * The quietest failure in the app: a Loki that answers, and holds somebody
 * else's logs.
 *
 * The history offer is only ever drawn where the reader has just been told
 * the live log has nothing left, so an empty answer confirms the exact belief
 * it exists to correct — the lines look gone when they are in a Loki nobody
 * pointed this at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { lokiQueryRange: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { coverage, verdict } from "./coverage";

const page = (lines: number) =>
  ({
    lines: Array.from({ length: lines }, () => ({ ts: "1", line: {} })),
  }) as never;

beforeEach(() => {
  vi.mocked(commands.lokiQueryRange).mockReset();
});

describe("whether this Loki holds this cluster's logs", () => {
  it("counts a namespace with any line at all as held", async () => {
    vi.mocked(commands.lokiQueryRange).mockResolvedValue(page(1));

    const found = await coverage(["web", "api"]);
    expect(found.namespaces.every((entry) => entry.holds)).toBe(true);
    expect(verdict(found)).toMatchObject({ tone: "ok" });
  });

  /** One line is proof, so one line is all that is asked for. */
  it("asks for a single line per namespace", async () => {
    vi.mocked(commands.lokiQueryRange).mockResolvedValue(page(1));
    await coverage(["web"]);
    expect(vi.mocked(commands.lokiQueryRange).mock.calls[0][3]).toBe(1);
    expect(vi.mocked(commands.lokiQueryRange).mock.calls[0][0]).toBe(
      '{namespace="web"}'
    );
  });

  it("says it holds none of it when every namespace comes back empty", async () => {
    vi.mocked(commands.lokiQueryRange).mockResolvedValue(page(0));

    const found = await coverage(["web", "api"]);
    expect(verdict(found)).toMatchObject({ tone: "err" });
  });

  /** Part of a cluster is a different sentence from none of it. */
  it("says it holds part of it when only some answer", async () => {
    vi.mocked(commands.lokiQueryRange).mockImplementation(async (selector) =>
      selector.includes("web") ? page(1) : page(0)
    );

    const found = await coverage(["web", "api"]);
    expect(verdict(found)).toMatchObject({ tone: "warn" });
  });

  /**
   * A refusal is not an absence. Reading one as the other would tell somebody
   * their logs are elsewhere when the truth is their token cannot ask.
   */
  it("keeps a refused query apart from an empty answer", async () => {
    vi.mocked(commands.lokiQueryRange).mockRejectedValue(
      new Error("401 Unauthorized")
    );

    const found = await coverage(["web"]);
    expect(found.namespaces[0].problem).toContain("401");
    expect(verdict(found)).toMatchObject({ tone: "warn" });
  });
});
