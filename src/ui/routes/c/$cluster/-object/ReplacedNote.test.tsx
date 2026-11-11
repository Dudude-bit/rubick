import { screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import type { PodInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: {
    listCrds: async () => [
      {
        group: "batch.volcano.sh",
        crds: [
          {
            name: "jobs.batch.volcano.sh",
            group: "batch.volcano.sh",
            kind: "Job",
          },
        ],
      },
    ],
  },
}));

const { ReplacedNote } = await import("./ReplacedNote");

const replaced = (apiVersion: string) =>
  ({
    namespace: "ml",
    status: { gone: "replaced" },
    ownerReferences: [
      {
        api_version: apiVersion,
        kind: "Job",
        name: "train",
        uid: "owner",
        controller: true,
      },
    ],
  }) as unknown as PodInfo;

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

/**
 * Volcano's Job owns pods as the batch Job does, under the same kind name.
 * Fails if the note opens the built-in Job of that name for either owner.
 */
it("opens the owner that replaced a pod by its group", async () => {
  const volcano = await renderWithRouter(
    <ReplacedNote pod={replaced("batch.volcano.sh/v1alpha1")} />
  );
  expect(await screen.findByRole("link", { name: /train/ })).toHaveAttribute(
    "href",
    "/c/test/jobs.batch.volcano.sh/ml/train"
  );
  volcano.unmount();

  await renderWithRouter(<ReplacedNote pod={replaced("batch/v1")} />);
  expect(await screen.findByRole("link", { name: /train/ })).toHaveAttribute(
    "href",
    "/c/test/jobs/ml/train"
  );
});
