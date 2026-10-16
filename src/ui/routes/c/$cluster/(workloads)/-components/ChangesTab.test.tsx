import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { queryKeys } from "@/lib/query-keys";
import { forgetRefusals } from "@/lib/refusals";
import { formatWhen } from "@/lib/utils";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { ChangesTab } from "./ChangesTab";

const LEDGER = {
  kind: "Deployment" as const,
  name: "ledger",
  namespace: "team-blind",
  labels: {},
  annotations: {},
  createdAt: null,
};

beforeEach(() => {
  forgetRefusals();
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

/**
 * Sam opened big-pull's page before applying it, and its Revisions kept the
 * NotFound from then beside the Deployment Ready. Fails if the timeline says
 * the revisions could not be read once the page has read the Deployment, or
 * does not ask for them again.
 */
it("reads a NotFound from before the Deployment was made as still reading, and asks again", async () => {
  let asked = 0;
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_deployment_replicasets") {
      asked += 1;
      return asked === 1
        ? Promise.reject({
            code: "NOT_FOUND",
            message: 'deployments.apps "ledger" not found',
          })
        : new Promise(() => {});
    }
    if (command.startsWith("list_") || command.startsWith("get_")) return [];
    return undefined;
  });
  const client = testQueryClient();
  await renderWithRouter(<ChangesTab subject={LEDGER} />, {
    at: "/c/prod",
    client,
  });
  expect(
    await screen.findByText(/The revisions could not be read/)
  ).toBeInTheDocument();

  client.setQueryData(queryKeys.detail("Deployment", "team-blind", "ledger"), {
    uid: "uid",
  });

  await waitFor(() =>
    expect(screen.queryByText(/The revisions could not be read/)).toBeNull()
  );
  await waitFor(() => expect(asked).toBe(2));
});

/**
 * The same stretch on a Deployment's own tab read "since" for up to 30 s
 * after the next watch began, while the page's clock waited for its next
 * half minute. Fails if the stretch's end waits for that clock.
 */
it("ends a stretch the moment the next watch begins, not at the next tick of the page's clock", async () => {
  const at = Date.parse("2026-10-12T11:44:20Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command.startsWith("list_") || command.startsWith("get_") ? [] : undefined
    );
    const blind = ["team-blind"];
    useChangeJournalStore.setState({
      entries: [],
      spans: {
        prod: [
          {
            from: at - 10 * 60_000,
            seenAt: at - 2 * 60_000,
            to: at - 2 * 60_000,
            scope: blind,
          },
          {
            from: at - 2 * 60_000,
            seenAt: at - 10_000,
            to: at - 10_000,
            scope: ["team-checkout"],
          },
          { from: at - 10_000, seenAt: at - 10_000, to: null, scope: blind },
        ],
      },
    });
    await renderWithRouter(<ChangesTab subject={LEDGER} />, { at: "/c/prod" });
    const ended = `Watching other namespaces, not this one, ${formatWhen(at - 2 * 60_000, "moment")} to ${formatWhen(at - 10_000, "moment")}`;
    expect(await screen.findByText(ended)).toBeInTheDocument();
    expect(screen.queryByText(/not this one, since/)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
