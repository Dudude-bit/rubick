/**
 * A failed read leaves the CRD list empty exactly as a cluster with no CRDs
 * does, and the page said "This cluster has no custom resource definitions."
 * for both. One is an answer; the other is that nobody could look — and
 * since every read got a deadline, the second is routine rather than
 * theoretical. The page never took `error` off its query at all.
 */

import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({
  commands: {
    listCrds: vi.fn(),
    deleteCrd: vi.fn(),
    objectLineage: () =>
      Promise.resolve({ uid: "crd", ancestors: [], others: [], stop: null }),
    previewCascade: () =>
      Promise.resolve({
        takes: [],
        notRead: { kinds: [], groups: [], watched: 40 },
        holds: {
          says: "objects",
          kind: "Certificate",
          group: "cert-manager.io",
          plural: "certificates",
          count: 4,
          reading: null,
        },
      }),
  },
}));

import { commands } from "@/lib/commands";
import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { Crds } from "./Crds";

const listCrds = vi.mocked(commands.listCrds);

function draw(ui: ReactElement = <Crds />) {
  return renderWithRouter(ui, {
    at: "/c/prod/customresourcedefinitions",
    route: "/c/$cluster/customresourcedefinitions",
  });
}

beforeEach(() => {
  listCrds.mockReset();
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("the CRD list when the read did not answer", () => {
  it("does not call a read that ran out of time an empty cluster", async () => {
    listCrds.mockRejectedValue(
      new Error("READ_DEADLINE: the cluster did not answer within 60 s")
    );
    await draw();
    await waitFor(() => {
      expect(screen.getByText(/could not read/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/has no custom resource definitions/i)
    ).toBeNull();
  });

  it("says a refusal is a refusal, not a failure to retry into", async () => {
    listCrds.mockRejectedValue(
      new Error("customresourcedefinitions is forbidden (code: 403)")
    );
    await draw();
    await waitFor(() => {
      expect(
        screen.getByText(/do not have permission to list/i)
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/has no custom resource definitions/i)
    ).toBeNull();
  });

  /**
   * The header said "none" and the footer "0 CRDs" around the refusal. Fails
   * if either counts a read nobody could make.
   */
  it("counts nothing, above or below, for a refused read", async () => {
    listCrds.mockRejectedValue(
      new Error("customresourcedefinitions is forbidden (code: 403)")
    );
    await draw();
    await screen.findByText(/do not have permission to list/i);
    const heading = screen.getByRole("heading", {
      name: "Custom Resource Definitions",
    });
    expect(
      within(heading.parentElement!).queryByTestId("section-count")
    ).toBeNull();
    expect(screen.queryByText(/\b0 CRDs\b/)).toBeNull();
  });

  it("still says the cluster has none when that is the answer", async () => {
    listCrds.mockResolvedValue([]);
    await draw();
    await waitFor(() => {
      expect(
        screen.getByText(/has no custom resource definitions/i)
      ).toBeInTheDocument();
    });
  });
});

describe("what the page offers Share", () => {
  /** The page bypasses ResourceList and builds its own DataTable; deleting
   *  the `share` prop on it leaves the CRD list with a button that opens an
   *  empty report. */
  it("collects a table section naming every listed CRD", async () => {
    listCrds.mockResolvedValue([
      {
        group: "cert-manager.io",
        crds: [
          {
            name: "certificates.cert-manager.io",
            group: "cert-manager.io",
            kind: "Certificate",
            plural: "certificates",
            scope: "Namespaced",
            version: "v1",
            shortNames: [],
            categories: [],
            createdAt: null,
          },
        ],
      },
    ]);

    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await draw(
      <ScreenShareProvider>
        <Crds />
        <Probe />
      </ScreenShareProvider>
    );

    await waitFor(() => {
      const table = collect?.().find(
        (section) => section.body.type === "table"
      );
      expect(table?.count).toBe(1);
    });
  });
});

describe("the row's way to a CRD's objects", () => {
  /** The link was built as `<crd>/instances`, a path no route serves, and
   *  opened an empty pane. The objects are a tab on the CRD's own page. */
  it("opens the CRD's page on its instances tab", async () => {
    listCrds.mockResolvedValue([
      {
        group: "cert-manager.io",
        crds: [
          {
            name: "certificates.cert-manager.io",
            group: "cert-manager.io",
            kind: "Certificate",
            plural: "certificates",
            scope: "Namespaced",
            version: "v1",
            shortNames: [],
            categories: [],
            createdAt: null,
          },
        ],
      },
    ]);
    await draw();

    const trigger = await screen.findByRole("button", {
      name: "Open actions",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const item = await screen.findByRole("menuitem", {
      name: "View instances",
    });

    expect(item.getAttribute("href")).toBe(
      "/c/prod/customresourcedefinitions/certificates.cert-manager.io?tab=instances"
    );
  });
});

describe("deleting a CRD from the list", () => {
  /**
   * The row's Delete asked one click and said nothing of how many objects
   * go with the definition. It asks for the name and counts them now.
   */
  it("counts the objects that go and asks for the name first", async () => {
    listCrds.mockResolvedValue([
      {
        group: "cert-manager.io",
        crds: [
          {
            name: "certificates.cert-manager.io",
            group: "cert-manager.io",
            kind: "Certificate",
            plural: "certificates",
            scope: "Namespaced",
            version: "v1",
            shortNames: [],
            categories: [],
            createdAt: null,
          },
        ],
      },
    ]);
    await draw();
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Open actions" }),
      { key: "Enter" }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(
      await screen.findByText("Every Certificate in the cluster goes with it:")
    ).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(commands.deleteCrd).not.toHaveBeenCalled();
  });
});

describe("a CRD's scope in the list", () => {
  /** The column printed spec.scope as written, "Namespaced", beside an API resources page that says the same fact in words. */
  it("says it in the words the API resources page uses", async () => {
    listCrds.mockResolvedValue([
      {
        group: "cert-manager.io",
        crds: [
          {
            name: "certificates.cert-manager.io",
            group: "cert-manager.io",
            kind: "Certificate",
            plural: "certificates",
            scope: "Namespaced",
            version: "v1",
            shortNames: [],
            categories: [],
            createdAt: null,
          },
          {
            name: "clusterissuers.cert-manager.io",
            group: "cert-manager.io",
            kind: "ClusterIssuer",
            plural: "clusterissuers",
            scope: "Cluster",
            version: "v1",
            shortNames: [],
            categories: [],
            createdAt: null,
          },
        ],
      },
    ]);
    await draw();
    expect(await screen.findByText("namespaced")).toBeInTheDocument();
    expect(screen.getByText("cluster-wide")).toBeInTheDocument();
    expect(screen.queryByText("Namespaced")).toBeNull();
  });
});

describe("a CRD with long names in the list", () => {
  /**
   * Sam read "ciliumclusterwidenetworkpoli…" and "ippools ippool lbippoo…"
   * at 1440 px with nothing to hover. Fails if either cut loses its whole
   * text, or the plural gets less room than the kind it is the plural of.
   */
  it("keeps the plural and the short names whole on hover", async () => {
    listCrds.mockResolvedValue([
      {
        group: "cilium.io",
        crds: [
          {
            name: "ciliumloadbalancerippools.cilium.io",
            group: "cilium.io",
            kind: "CiliumLoadBalancerIPPool",
            plural: "ciliumloadbalancerippools",
            scope: "Cluster",
            version: "v2",
            shortNames: ["ippools", "ippool", "lbippool", "lbippools"],
            categories: [],
            createdAt: null,
          },
        ],
      },
    ]);
    await draw();
    expect(
      await screen.findByText("ciliumloadbalancerippools")
    ).toHaveAttribute("title", "ciliumloadbalancerippools");
    expect(
      screen.getByText("ippools ippool lbippool lbippools")
    ).toHaveAttribute("title", "ippools ippool lbippool lbippools");
    const width = (header: string) =>
      parseFloat(screen.getByText(header).closest("th")!.style.width);
    expect(width("Plural")).toBeGreaterThanOrEqual(width("Kind"));
  });
});
