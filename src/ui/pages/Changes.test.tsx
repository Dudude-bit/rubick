import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { Changes } from "./Changes";

const NOW = Date.now();

async function mount() {
  let collect: ReturnType<typeof useScreenSections> = null;
  function Probe() {
    collect = useScreenSections();
    return null;
  }
  await renderWithRouter(
    <ScreenShareProvider>
      <Changes />
      <Probe />
    </ScreenShareProvider>,
    { at: "/c/prod/changes", route: "/c/$cluster/changes" }
  );
  return () => collect!();
}

describe("what the Changes page offers Share", () => {
  /** Deleting the object's ref on a journal row leaves a shared report of a
   *  cluster-wide timeline with no way to tell which workload a row is about. */
  it("carries a ref on a journal row and marks the section watched", async () => {
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

    const collect = await mount();
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

    const collect = await mount();
    await waitFor(() => {
      const watched = collect().find(
        (section) => section.id === "changes-watched"
      );
      expect(watched?.body).toMatchObject({ type: "text", role: "warn" });
    });
  });
});
