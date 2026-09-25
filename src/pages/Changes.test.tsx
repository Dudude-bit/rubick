import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { Changes } from "./Changes";

const NOW = Date.now();

function mount() {
  let collect: ReturnType<typeof useScreenSections> = null;
  function Probe() {
    collect = useScreenSections();
    return null;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScreenShareProvider>
          <Changes />
          <Probe />
        </ScreenShareProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return () => collect!();
}

describe("what the Changes page offers Share", () => {
  /** Deleting the object's ref on a journal row leaves a shared report of a
   *  cluster-wide timeline with no way to tell which workload a row is about. */
  it("carries a ref on a journal row and marks the section watched", () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: [],
    });
    useChangeJournalStore.setState({
      entries: [
        {
          id: "1",
          context: "prod",
          kind: "Deployment",
          namespace: "shop",
          name: "payments",
          at: NOW - 60_000,
          field: "image",
          key: "app",
          from: "v1",
          to: "v2",
        },
      ],
      spans: {
        prod: [{ from: NOW - 3_600_000, seenAt: NOW, to: null }],
      },
    });

    const collect = mount();
    const sections = collect();
    const changes = sections.find((section) => section.id === "changes");
    expect(changes?.body.type).toBe("changes");
    const rows = changes?.body.type === "changes" ? changes.body.changes : [];
    expect(rows[0]).toMatchObject({
      ref: { kind: "Deployment", stem: "payments" },
    });

    const watched = sections.find(
      (section) => section.id === "changes-watched"
    );
    expect(watched?.body).toMatchObject({ type: "text" });
  });

  /** A gap in the window must read as "not observed", never as a quiet
   *  timeline: deleting the gap row lets a real blind spot pass as calm. */
  it("says a gap was not observed rather than dropping it", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: [],
    });
    useChangeJournalStore.setState({
      entries: [],
      spans: {
        prod: [
          {
            from: NOW - 2_000_000,
            seenAt: NOW - 1_000_000,
            to: NOW - 1_000_000,
          },
        ],
      },
    });

    const collect = mount();
    await waitFor(() => {
      const watched = collect().find(
        (section) => section.id === "changes-watched"
      );
      expect(watched?.body).toMatchObject({ type: "text", role: "warn" });
    });
  });
});
