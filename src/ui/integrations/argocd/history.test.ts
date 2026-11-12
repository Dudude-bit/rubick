import { describe, expect, it, vi } from "vite-plus/test";

import type { DeliveryOwner } from "../gitops";

vi.mock("@/lib/commands", () => ({
  commands: {
    getCustomResource: async () => ({
      status: {
        history: [
          {
            id: 3,
            revision: "eec06d1",
            deployedAt: "2026-09-09T18:00:00Z",
            source: {
              repoURL:
                "https://oauth2:glpat-" +
                "AbCdEf0123456789xyzQ@gitlab.example.com/org/repo.git",
            },
          },
        ],
      },
    }),
  },
}));

const { historyOf } = await import("./history");

/**
 * A history entry with no path is named by its repository, and that is the
 * address as Argo recorded it, token included. Fails if the Deliveries tab
 * is handed what stands before the host.
 */
describe("where an Argo CD revision came from", () => {
  it("names a repository without the credentials in its address", async () => {
    const revisions = await historyOf({
      kind: "Application",
      name: "shop",
      namespace: "argocd",
    } as DeliveryOwner);
    expect(revisions?.map((revision) => revision.from)).toEqual([
      "https://…@gitlab.example.com/org/repo.git",
    ]);
  });
});
