/**
 * A Helm-release list read that the cluster refused must read as a refusal —
 * not as an empty "no releases" table, which is the empty-collection-on-a-403
 * collapse the app exists to prevent. A refusal that still returned some rows
 * (another namespace answered) shows those rows. Deleting the error branch or
 * the isRefusal split puts the silent-empty-table back.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import type { HelmRelease } from "@/generated/types";
import type { PlacedSection } from "@/lib/report-parts";
import { unreadLines } from "@/lib/report-parts";
import { renderWithRouter } from "@/test/render";
import { HelmReleasesTab } from "./HelmReleasesTab";

const release = (name: string): HelmRelease => ({
  name,
  namespace: "team-a",
  revision: 1,
  status: "deployed",
  chart: "nginx-1.0.0",
  appVersion: "1.0.0",
  updated: "2026-09-05T10:00:00Z",
  source: "native",
  suspended: false,
  sourceRef: null,
  unreadable: null,
});

let collect: (() => PlacedSection[]) | null = null;
function Probe() {
  collect = useScreenSections();
  return null;
}

function mount(props: Partial<Parameters<typeof HelmReleasesTab>[0]> = {}) {
  return renderWithRouter(
    <ScreenShareProvider>
      <HelmReleasesTab
        releases={[]}
        isLoading={false}
        error={null}
        helmCliAvailable={true}
        onRefetch={vi.fn()}
        onShowHistory={vi.fn()}
        onUpgrade={vi.fn()}
        onRollback={vi.fn()}
        onUninstall={vi.fn()}
        {...props}
      />
      <Probe />
    </ScreenShareProvider>,
    { at: "/c/test/helm", route: "/c/$cluster/helm" }
  );
}

describe("what the releases tab does when the read fails", () => {
  // The errors are raw strings on purpose: the query's thrown value is not
  // guaranteed to be an Error, and reading `.message` off a string (the old
  // code did) throws mid-render. Passing an Error here would test a shape the
  // page need not produce and hide that crash — so these are strings, the
  // harsher case.
  it("names a refusal instead of showing an empty table", async () => {
    await mount({
      error:
        "Tauri command 'listHelmReleasesIn' failed: secrets is forbidden (code: 403)",
    });

    expect(
      screen.getByText(/do not have permission to list/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/secrets is forbidden/)).toBeInTheDocument();
    // The framing prefix is off the message.
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
  });

  it("calls a non-refusal failure a read error, not a refusal", async () => {
    await mount({ error: "error trying to connect: connection refused" });

    expect(
      screen.getByText(/Could not read Helm releases/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to list/i)
    ).not.toBeInTheDocument();
  });

  it("still shows the rows a readable namespace returned despite a sibling's refusal", async () => {
    await mount({
      releases: [release("api"), release("web")],
      error: "secrets is forbidden (code: 403)",
    });

    // Rows present -> the table, not the refusal block.
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to list/i)
    ).not.toBeInTheDocument();
  });
});

/**
 * The empty message already knew a namespace went unread, but the footer
 * under the rows still printed "1 row", the count of what answered stated
 * as the count of the scope.
 */
describe("the releases tab beside a namespace it could not read", () => {
  it("does not call the rows a total in the footer", async () => {
    await mount({
      releases: [release("api")],
      unread: [
        { namespace: "team-b", code: "FORBIDDEN", message: "forbidden" },
      ],
    });

    expect(
      screen.getByText("1 row, from the namespaces that answered")
    ).toBeInTheDocument();
    expect(screen.queryByText("1 row")).toBeNull();
  });
});

/**
 * The notice above the table named the namespace that refused its Secrets,
 * and the shared file wrote "Releases 1" and "Everything this report names
 * was read": the table registered a title and nothing of its read. Fails if
 * the file's section does not carry what the screen says of the same rows.
 */
describe("what the releases tab hands to Share", () => {
  it("names the namespace that did not answer and gives no count", async () => {
    await mount({
      releases: [release("api")],
      unread: [
        { namespace: "shared", code: "FORBIDDEN", message: "secrets denied" },
      ],
    });
    const [section] = collect!();
    expect(section.partial).toBe(
      "Could not read Helm releases in shared. (secrets denied)"
    );
    expect(section.count).toBeNull();
    expect(unreadLines([section])).toHaveLength(1);
  });

  it("says a first read still in flight is not an empty list", async () => {
    await mount({ isLoading: true });
    const [section] = collect!();
    expect(section.unread).toBe("Still being read when the report was made.");
  });

  it("gives the whole count when every namespace answered", async () => {
    await mount({ releases: [release("api")] });
    const [section] = collect!();
    expect(section.count).toBe(1);
    expect(unreadLines([section])).toEqual([]);
  });
});

/**
 * The release the app could not read must be on the page as itself, not as
 * an absence. A secret that would not decode was dropped with a
 * `tracing::warn!` nobody reads, so the page reported the survivors as the
 * whole truth — "this cluster has no Helm releases" composed out of a read
 * that failed, which is the one lie this app exists not to tell.
 */
describe("a release whose secret would not decode", () => {
  it("is a row that says so, not a row that is missing", async () => {
    await mount({
      releases: [
        {
          ...release("shop-api"),
          status: "",
          chart: "",
          unreadable: "missing field `config`",
        },
      ],
    });
    expect(await screen.findByText("shop-api")).toBeInTheDocument();
    expect(screen.getByText("could not be read")).toBeInTheDocument();
    expect(screen.getByTitle("missing field `config`")).toBeInTheDocument();
  });
});

describe("two releases whose namespace and name run together the same way", () => {
  /**
   * `nightly` in `data-sync` and `sync-nightly` in `data` were both the row
   * `native-data-sync-nightly`: one React key for two rows, and a selection,
   * an Enter or a row menu on the second reached the first. Fails if the two
   * releases are not a row each.
   */
  it("are a row each", async () => {
    const twice = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount({
      releases: [
        { ...release("nightly"), namespace: "data-sync" },
        { ...release("sync-nightly"), namespace: "data" },
      ],
    });

    expect(screen.getByText("nightly")).toBeInTheDocument();
    expect(screen.getByText("sync-nightly")).toBeInTheDocument();
    expect(
      twice.mock.calls.filter(([said]) => /same key/.test(String(said)))
    ).toEqual([]);
    twice.mockRestore();
  });
});
