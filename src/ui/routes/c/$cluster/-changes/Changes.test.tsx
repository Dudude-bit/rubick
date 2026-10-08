import { describe, expect, it } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
import { formatWhen } from "@/lib/utils";
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

  /**
   * A kind the cluster refused is named beside "watching": without it the
   * header claims every workload kind is on the clock.
   */
  it("names the kinds the cluster refused to let it watch", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: ["team-checkout"],
    });
    useChangeJournalStore.setState({
      entries: [],
      spans: {
        prod: [
          {
            from: NOW - 60_000,
            seenAt: NOW,
            to: null,
            unwatched: ["DaemonSet"],
          },
        ],
      },
    });

    const collect = await mount();
    expect(
      screen.getByText("DaemonSet not watched: the cluster refused")
    ).toBeInTheDocument();
    const watched = collect().find(
      (section) => section.id === "changes-watched"
    );
    expect(watched?.body).toMatchObject({
      text: expect.stringContaining("DaemonSet not watched"),
      role: "warn",
    });
  });
});

describe("rows older than the running watch", () => {
  const MIN = 60_000;
  const lenaRow = (id: string, ago: number) => ({
    id,
    context: "prod",
    kind: "Deployment",
    namespace: "lena-sandbox",
    name: "hello-web",
    at: NOW - ago * MIN,
    field: "replicas" as const,
    key: null,
    from: "1",
    to: "2",
  });
  const allNamespaces = {
    from: NOW - 25 * MIN,
    seenAt: NOW - MIN,
    to: NOW - MIN,
  };
  const lenaSandbox = {
    from: NOW - MIN,
    seenAt: NOW,
    to: null,
    scope: ["lena-sandbox"],
  };

  /**
   * Lena's lena-sandbox Changes read "Watching since 06:55:06" over a line
   * saying it watched from 06:37: a scope change had retired one span and
   * opened the next at the same moment. Fails if the page or Share dates the
   * watch from the span instead of from where the unbroken watch began.
   */
  it("dates an unbroken watch from where it began, on the page and in Share", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: ["lena-sandbox"],
    });
    useChangeJournalStore.setState({
      entries: [lenaRow("a", 16), lenaRow("b", 6), lenaRow("c", 5)],
      spans: { prod: [allNamespaces, lenaSandbox] },
    });

    const collect = await mount();
    const since = `Watching since ${formatWhen(allNamespaces.from, "clock")}`;
    expect(screen.getByText(since)).toBeInTheDocument();
    expect(screen.queryByText(/were recorded by this app/)).toBeNull();
    const utc = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(allNamespaces.from);
    const shared = collect().find((section) => section.id === "changes-watched")
      ?.body as { text: string };
    const sharedSince = `Watching since ${utc} UTC`;
    expect(shared.text.slice(0, sharedSince.length)).toBe(sharedSince);
    expect(shared.text.includes("were recorded")).toBe(false);
  });

  /** Fails if rows from a watch the app broke off are left without saying where they came from. */
  it("says the app recorded them while it watched earlier, across a gap", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: ["lena-sandbox"],
    });
    useChangeJournalStore.setState({
      entries: [lenaRow("a", 50), lenaRow("b", 5)],
      spans: {
        prod: [
          { from: NOW - 60 * MIN, seenAt: NOW - 40 * MIN, to: NOW - 40 * MIN },
          { ...lenaSandbox, from: NOW - 30 * MIN },
        ],
      },
    });

    await mount();
    expect(
      screen.getByText(`Watching since ${formatWhen(NOW - 30 * MIN, "clock")}`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Rows before .+ were recorded by this app while it watched from .+ to .+$/
      )
    ).toBeInTheDocument();
  });

  /** Fails if the line is said where every row is the running watch's own. */
  it("says nothing about an earlier watch when every row is the running watch's own", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: ["lena-sandbox"],
    });
    useChangeJournalStore.setState({
      entries: [lenaRow("now", 0.5)],
      spans: { prod: [allNamespaces, lenaSandbox] },
    });

    await mount();
    expect(screen.getByText(/^Watching since/)).toBeInTheDocument();
    expect(screen.queryByText(/were recorded by this app/)).toBeNull();
  });
});

describe("a watch that has recorded nothing", () => {
  const MIN = 60_000;
  const watchingSince = NOW - 10 * MIN;
  const yesterday = {
    from: NOW - 30 * 60 * MIN,
    seenAt: NOW - 20 * 60 * MIN,
    to: NOW - 20 * 60 * MIN,
  };
  const running = { from: watchingSince, seenAt: NOW, to: null };
  const quiet = `No change recorded since ${formatWhen(watchingSince, "clock")}: no workload here was created, deleted, scaled or edited.`;

  /**
   * Marco's Changes page showed only the "Not observed" box, never whether
   * the watch since 06:37 had seen nothing or was still loading. Fails if a
   * quiet watch is left unsaid, on the page or in Share.
   */
  it("says no change was recorded since the watch began, beside the gap before it", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: [],
    });
    useChangeJournalStore.setState({
      entries: [],
      spans: { prod: [yesterday, running] },
    });

    const collect = await mount();
    expect(screen.getByTestId("changes-quiet").textContent).toBe(quiet);
    expect(screen.getByText(/^Not observed /)).toBeInTheDocument();
    const watched = collect().find(
      (section) => section.id === "changes-watched"
    );
    expect(watched?.body).toMatchObject({
      text: expect.stringContaining("No change recorded since"),
    });
  });

  /** Fails if a change the running watch recorded is denied, or one recorded before it counts as its own. */
  it("counts only the running watch's own rows", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: [],
    });
    const row = (id: string, at: number) => ({
      id,
      context: "prod",
      kind: "Deployment",
      namespace: "team-checkout",
      name: "worker",
      at,
      field: "replicas" as const,
      key: null,
      from: "1",
      to: "0",
    });
    useChangeJournalStore.setState({
      entries: [row("before", NOW - 21 * 60 * MIN)],
      spans: { prod: [yesterday, running] },
    });
    await mount();
    expect(screen.getByTestId("changes-quiet").textContent).toBe(quiet);

    useChangeJournalStore.setState({
      entries: [row("before", NOW - 21 * 60 * MIN), row("now", NOW - MIN)],
    });
    await waitFor(() =>
      expect(screen.queryByTestId("changes-quiet")).toBeNull()
    );
  });
});

describe("the Changes window toggle", () => {
  /** Russian read "24ч" and "7д" here and "24 ч" on every age beside it. Fails if the toggle stops using the locale's own units. */
  it("names its windows the way every age in the reader's language is written", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    useChangeJournalStore.setState({ entries: [], spans: {} });
    useLocaleStore.setState({ choice: "ru" });
    await mount();
    expect(screen.getByRole("button", { name: "24 ч" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7 д." })).toBeInTheDocument();
    useLocaleStore.setState({ choice: null });
  });
});
