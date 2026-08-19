/**
 * The cluster line only speaks when cert-manager is behind its own plan.
 *
 * Pinned because of #68: a fleet of seven-day certificates renewing on
 * schedule used to read "N expire within 14 days" forever, which taught the
 * reader to ignore the one line that was ever going to matter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { listCustomResources: vi.fn() },
}));

import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";

import { facts } from "./facts";

const DAY = 86_400_000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();

let uids = 0;

function certificate(over: {
  notBefore?: string;
  notAfter?: string;
  renewalTime?: string;
}): CustomResourceInfo {
  return {
    name: `cert-${++uids}`,
    namespace: "shop",
    uid: `uid-${uids}`,
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: {},
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      notBefore: over.notBefore ?? inDays(-4.75),
      notAfter: over.notAfter ?? inDays(2.25),
      ...(over.renewalTime !== undefined
        ? { renewalTime: over.renewalTime }
        : {}),
    },
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

const listed = (certificates: CustomResourceInfo[]) =>
  vi.mocked(commands.listCustomResources).mockResolvedValue(certificates);

beforeEach(() => vi.clearAllMocks());

describe("cert-manager facts", () => {
  it("says nothing loud about short certificates renewing on schedule", async () => {
    listed([
      certificate({ renewalTime: inDays(1.5) }),
      certificate({ renewalTime: inDays(1.5) }),
    ]);
    const lines = await facts();
    expect(lines[0].text).toBe("2 certificates");
    expect(lines.every((line) => line.tone === undefined)).toBe(true);
  });

  it("calls one missed renewal what it is", async () => {
    listed([
      certificate({ renewalTime: inDays(1.5) }),
      certificate({ renewalTime: inDays(-0.5) }),
    ]);
    const lines = await facts();
    expect(lines).toContainEqual({ text: "1 renewal overdue", tone: "warn" });
  });

  it("counts several missed renewals", async () => {
    listed([
      certificate({ renewalTime: inDays(-0.5) }),
      certificate({ renewalTime: inDays(-1) }),
    ]);
    const lines = await facts();
    expect(lines).toContainEqual({ text: "2 renewals overdue", tone: "warn" });
  });

  /**
   * A certificate cert-manager never wrote a plan for still deserves the
   * plain expiry sentence — silence would need a reason nobody has given.
   */
  it("keeps the plain sentence where there is no plan", async () => {
    listed([certificate({})]);
    const lines = await facts();
    expect(lines).toContainEqual({ text: "1 expires in 2 days", tone: "warn" });
  });
});
