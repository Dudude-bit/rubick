import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useLocation } from "@tanstack/react-router";
import { Info } from "lucide-react";

import { SectionHeader } from "@/components/ui/section";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { DetailError, ResourceDetailLayout } from "./ResourceDetailLayout";
import { useObjectUnread } from "./object-unread";

const shellItems = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/hooks/useAttention", () => ({
  useAttention: () =>
    shellItems.items.length > 0 ? { items: shellItems.items } : null,
}));
import { useResourceDetail } from "@/hooks/useResourceDetail";
import { renderWithRouter } from "@/test/render";
import { parseAlert } from "@/lib/alerts";
import { useAlertArrivalStore } from "@/stores/alertArrivalStore";
import {
  countMark,
  kindGlyph,
  liveMark,
  severityMark,
  viewGlyph,
  type DetailTab,
} from "@/components/object/detail-tab";

const wrap = (ui: ReactNode, at = "/c/prod/persistentvolumes/pv-demo") =>
  renderWithRouter(<>{ui}</>, { at, route: "/c/$cluster/$" });

const wrapRerenderable = async (initial: ReactNode) => {
  const rendered = await wrap(initial);
  return {
    ...rendered,
    rerender: (next: ReactNode) => rendered.rerender(<>{next}</>),
  };
};

/** Where a click landed, read out of the router rather than guessed at. */
function LocationProbe() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return <span data-testid="location">{pathname}</span>;
}

const base = {
  // A loaded object: the layout renders its "not found" state instead when
  // `resource` is nullish, and that state has no tabs at all.
  resource: { name: "pv-demo" },
  title: "pv-demo",
  resourceKind: "PersistentVolume",
  isLoading: false,
  error: null,
  onBack: () => {},
  onTabChange: () => {},
};

/**
 * Nothing of the page's own grows above the tab strip.
 *
 * This is the whole shape of the page and not a detail of it: the strip
 * carries Scale, Restart and Delete on its row, so anything that can grow
 * between the header and the strip can push every control off the screen. It
 * did — the day the Overview became full-width blocks, a StatefulSet's Scale
 * button moved a screen below the fold. The frame therefore has no slot for
 * blocks at all, and the blocks are the first tab's content.
 */
describe("ResourceDetailLayout puts nothing of the page above the strip", () => {
  it("will not compile a page that hands the frame blocks", () => {
    const blocks = (
      // @ts-expect-error - the frame takes no children. If this line ever
      // stops being an error, a page can render above the strip again and the
      // controls can leave the screen with it.
      <ResourceDetailLayout {...base} activeTab="overview" tabs={[]}>
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    expect(blocks).toBeTruthy();
  });

  it("draws the open tab's content after the strip, never before it", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: <p>capacity 2Gi</p>,
          },
        ]}
      />
    );
    const strip = screen.getByRole("tablist");
    const block = screen.getByText("capacity 2Gi");
    expect(
      strip.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  /**
   * The one exception, and it earns it: what is wrong with the *object* is
   * worth its two lines on every tab, including a full-height one.
   */
  it("keeps the summary above the strip, on a surface tab as much as any", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="logs"
        summary={<p>CrashLoopBackOff — the container keeps exiting</p>}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "logs",
            label: "Logs",
            glyph: viewGlyph(Info),
            kind: "surface",
            content: null,
          },
        ]}
      />
    );
    const strip = screen.getByRole("tablist");
    const said = screen.getByText(/CrashLoopBackOff/);
    expect(
      strip.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });
});

/**
 * A surface owns the page's height. It used to be denied that on a page whose
 * every tab was a surface, because hiding the blocks above the strip for good
 * is how PersistentVolume once lost its capacity, binding and reclaim policy.
 * There is nothing above the strip to hide any more — a page's blocks are a
 * tab, and PersistentVolume's are its Overview — so the exception is gone and
 * a page made only of surfaces gets the window it is built to fill.
 */
describe("ResourceDetailLayout and who owns the height", () => {
  const onlySurfaces = (
    <ResourceDetailLayout
      {...base}
      activeTab="yaml"
      tabs={[
        {
          id: "yaml",
          label: "YAML",
          glyph: viewGlyph(Info),
          kind: "surface",
          content: null,
        },
      ]}
    />
  );

  it("gives the window to a page whose every tab is a surface", async () => {
    const { container } = await wrap(onlySurfaces);
    expect(container.firstChild).toHaveClass("h-full");
  });

  it("leaves the page scrolling on a tab made of blocks", async () => {
    const { container } = await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "yaml",
            label: "YAML",
            glyph: viewGlyph(Info),
            kind: "surface",
            content: null,
          },
        ]}
      />
    );
    expect(container.firstChild).not.toHaveClass("h-full");
  });

  /**
   * Logs, Shell, Files and YAML drew the strip 4 px higher than the other
   * tabs, 8 px under a banner, so the tab moved under the pointer that had
   * just clicked it. Fails if a surface tab spaces the column differently.
   */
  it("keeps the strip where it is when a surface tab opens", async () => {
    const tabs: DetailTab[] = [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(Info),
        content: null,
      },
      {
        id: "logs",
        label: "Logs",
        glyph: viewGlyph(Info),
        kind: "surface",
        content: null,
      },
    ];
    const spacing = (el: ChildNode | null) =>
      [...((el as HTMLElement).classList ?? [])].filter((c) =>
        /^(gap|space-y|mt|pt|py)-/.test(c)
      );
    const { container, rerender } = await wrapRerenderable(
      <ResourceDetailLayout {...base} activeTab="overview" tabs={tabs} />
    );
    const onBlocks = spacing(container.firstChild);
    rerender(<ResourceDetailLayout {...base} activeTab="logs" tabs={tabs} />);
    expect(container.firstChild).toHaveClass("h-full");
    expect(spacing(container.firstChild)).toEqual(onBlocks);
  });
});

/**
 * A surface tab holds something live: an attached shell, a log stream, an
 * editor's undo history. Radix unmounts the panel of every tab that is not the
 * open one, so a shell opened here died the instant the reader clicked Logs —
 * which is the whole reason the shell was moved onto a tab. Unmounting a
 * surface is not hiding it, it is ending it.
 *
 * The other half of the rule matters just as much: a surface nobody has opened
 * must not be mounted, or arriving on a pod would open an exec session into it.
 */
describe("ResourceDetailLayout surface tabs and what lives in them", () => {
  const mounted = vi.fn();

  function Session() {
    useEffect(() => {
      mounted();
    }, []);
    return <p>attached to app</p>;
  }

  const withShell = (activeTab: string) => ({
    ...base,
    activeTab,
    tabs: [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(Info),
        content: null,
      },
      {
        id: "shell",
        label: "Shell",
        glyph: viewGlyph(Info),
        kind: "surface" as const,
        content: <Session />,
      },
    ],
  });

  it("keeps a session alive through a trip to another tab and back", async () => {
    mounted.mockClear();
    const { rerender } = await wrapRerenderable(
      <ResourceDetailLayout {...withShell("shell")} />
    );
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(<ResourceDetailLayout {...withShell("overview")} />);
    // Still in the DOM, merely off the screen: `hidden` is what a reader loses
    // when they click away, and the session is not theirs to lose with it.
    expect(screen.getByText("attached to app")).toBeInTheDocument();

    rerender(<ResourceDetailLayout {...withShell("shell")} />);
    // The number that matters: a second mount would be a second `openPodShell`
    // and a dead prompt where the reader left a live one.
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("does not mount a surface nobody has opened", async () => {
    mounted.mockClear();
    await wrap(<ResourceDetailLayout {...withShell("overview")} />);
    expect(screen.queryByText("attached to app")).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
  });
});

/**
 * One band of chrome, not two. The page's actions belong on the tab strip's
 * row, and the header keeps only what says which object this is.
 */
describe("ResourceDetailLayout chrome", () => {
  const withActions = (activeTab: string, kind?: "sections" | "surface") =>
    wrap(
      <ResourceDetailLayout
        {...base}
        createdAt="2020-01-01T00:00:00Z"
        activeTab={activeTab}
        actions={<button type="button">Delete</button>}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "yaml",
            label: "YAML",
            glyph: viewGlyph(Info),
            kind,
            content: null,
          },
        ]}
      />
    );

  it("puts the actions on the tab strip's row", async () => {
    await withActions("overview");
    const row = screen.getByRole("tablist").parentElement?.parentElement;
    expect(row).toContainElement(
      screen.getByRole("button", { name: "Delete" })
    );
  });

  it("keeps them off the header, which is now identity only", async () => {
    await withActions("overview");
    const header = screen
      .getByRole("heading", { level: 1 })
      .closest("div")?.parentElement;
    expect(header).not.toContainElement(
      screen.getByRole("button", { name: "Delete" })
    );
  });

  /** Lena's pod page at 1024 scrolled its tabs and Delete off the screen with the page. Fails if the strip's row stops sticking to the top of the page scroll over an opaque background. */
  it("keeps the tab strip and its actions in view while the page scrolls", async () => {
    await withActions("overview");
    const row = screen.getByRole("tablist").parentElement?.parentElement;
    expect(row).toHaveClass("sticky", "top-0", "bg-canvas");
  });

  // tab, to buy back the second row it needed for the actions. It is one row
  // either way now, so there is nothing to buy and nothing to drop — and a
  // header that restructures itself when the reader clicks Logs reads as the
  // page reloading.
  it("says the same things on a full-height tab as on any other", async () => {
    await withActions("yaml", "surface");
    expect(screen.getByText(/old/)).toBeInTheDocument();
  });
});

/**
 * The strip is a heading. Whatever a tab opens with does not get to say the
 * word the reader just clicked, and no block gets to say the kind the
 * breadcrumb and the title already carry.
 */
describe("ResourceDetailLayout captions", () => {
  it("drops a block heading that only repeats the tab label", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="conditions"
        tabs={[
          {
            id: "conditions",
            label: "Conditions",
            glyph: viewGlyph(Info),
            content: <SectionHeader title="Conditions" />,
          },
        ]}
      />
    );
    expect(
      screen.queryByRole("heading", { name: "Conditions" })
    ).not.toBeInTheDocument();
  });

  it("keeps the count the strip does not carry, with its noun", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="conditions"
        tabs={[
          {
            id: "conditions",
            label: "Conditions",
            glyph: viewGlyph(Info),
            content: <SectionHeader title="Conditions" count={3} />,
          },
        ]}
      />
    );
    expect(screen.getByText("3 conditions")).toBeInTheDocument();
  });

  it("drops a block heading that only repeats the kind", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: <SectionHeader title="PersistentVolume" />,
          },
        ]}
      />
    );
    expect(
      screen.queryByRole("heading", { name: "PersistentVolume" })
    ).not.toBeInTheDocument();
  });

  it("leaves a heading that says something new", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="access"
        tabs={[
          {
            id: "access",
            label: "Access",
            glyph: viewGlyph(Info),
            content: <SectionHeader title="Reachable at" />,
          },
        ]}
      />
    );
    expect(
      screen.getByRole("heading", { name: "Reachable at" })
    ).toBeInTheDocument();
  });
});

/**
 * The strip is scanned, not read. A tab without a glyph is a tab that has to
 * be read to be told from its neighbours, and one page shipping four glyphs
 * beside fourteen bare words is worse than none of them having any — so the
 * rule is enforced twice: the type will not compile a tab without one, and
 * the strip is asserted to draw one for every tab it is given.
 */
describe("ResourceDetailLayout glyphs", () => {
  const glyphOf = (name: string | RegExp) =>
    screen.getByRole("tab", { name }).querySelector("svg");

  it("will not compile a tab that ships without a glyph", () => {
    // @ts-expect-error - `glyph` is required. If this line ever stops being an
    // error, eighteen pages have quietly been allowed to drop theirs.
    const glyphless: DetailTab = { id: "x", label: "X", content: null };
    expect(glyphless.label).toBe("X");
  });

  it("draws one for every tab, and hides it from the accessible name", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "pods",
            label: "Pods",
            glyph: kindGlyph("Pod"),
            content: null,
          },
        ]}
      />
    );
    for (const tab of screen.getAllByRole("tab")) {
      const glyphs = tab.querySelectorAll("svg");
      expect(glyphs).toHaveLength(1);
      expect(glyphs[0]).toHaveAttribute("aria-hidden", "true");
    }
  });

  /**
   * A tab that names a kind keeps that kind's hue whether or not it is the
   * open one — meeting the same cube on a Deployment's Pods tab that was
   * clicked in the sidebar is the entire reason kinds carry a hue.
   */
  it("tints a tab that names a kind, active or not", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "pods",
            label: "Pods",
            glyph: kindGlyph("Pod"),
            content: null,
          },
        ]}
      />
    );
    expect(glyphOf("Pods")?.getAttribute("style")).toContain("var(--kind-s)");
  });

  /** A view is a verb. Giving it a hue would claim it is a resource. */
  it("leaves a tab that names a view untinted", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
        ]}
      />
    );
    expect(glyphOf("Overview")?.getAttribute("style") ?? "").not.toContain(
      "hsl"
    );
  });
});

/**
 * A mark earns its pixels by changing which tab gets clicked, and it never
 * spends colour alone: the words are in the accessible name, because a red
 * disc is nothing at all to a reader who cannot see red.
 */
describe("ResourceDetailLayout tab marks", () => {
  const strip = (mark: DetailTab["mark"]) =>
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
          {
            id: "containers",
            label: "Containers",
            glyph: kindGlyph("Pod"),
            mark,
            content: null,
          },
        ]}
      />
    );

  it("says how many a collection holds, so an empty one needs no click", async () => {
    await strip(countMark(0));
    expect(screen.getByRole("tab", { name: /Containers/ })).toHaveTextContent(
      "Containers0"
    );
  });

  it("puts a severity dot's meaning into words", async () => {
    await strip(severityMark("err", "1 of 4 failing"));
    expect(
      screen.getByRole("tab", { name: "Containers: 1 of 4 failing" })
    ).toBeInTheDocument();
  });

  it("does the same for a live session", async () => {
    await strip(liveMark("session attached to app"));
    expect(
      screen.getByRole("tab", { name: "Containers: session attached to app" })
    ).toBeInTheDocument();
  });

  /**
   * The only animated thing in the strip, which is what lets it mean one
   * thing — and it stops for a reader who asked motion to stop.
   */
  it("animates the live dot and nothing else, and not under reduced motion", async () => {
    await strip(liveMark("session attached to app"));
    const dot = screen
      .getByRole("tab", { name: /Containers/ })
      .querySelector("span[aria-hidden='true']");
    expect(dot?.className).toContain("animate-tab-live");
    expect(dot?.className).toContain("motion-reduce:animate-none");
  });
});

/**
 * The kind segment of the breadcrumb is a `<Link>` on every page, and an
 * unrouted destination inside the layout route matches no branch at all —
 * React Router renders nothing and the whole shell disappears. A kind with no
 * list page has to say the word without offering it.
 */
describe("the breadcrumb's kind segment", () => {
  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: null,
    },
  ];

  it("links to the list route the sidebar uses", async () => {
    await wrap(
      <ResourceDetailLayout {...base} activeTab="overview" tabs={tabs} />
    );
    expect(
      screen.getByRole("link", { name: "Persistent Volumes" })
    ).toHaveAttribute("href", "/c/prod/persistentvolumes");
  });

  it("is plain text when there is nowhere to go", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        resourceKind="ReplicaSet"
        listLink={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    expect(screen.getByText("ReplicaSets")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ReplicaSets" })).toBeNull();
  });
});

/**
 * `pods / k8s-gui-test / burst-demo` reads as a path, and for as long as the
 * middle of it was a `<span>` only two thirds of it behaved like one. The
 * segment stands for a scope, so it hands the tab that scope on the way to
 * the list — and a modified gesture that opened a tab *without* it would put
 * the reader's second view of `k8s-gui-test` on a tab scoped to everything.
 */
describe("the breadcrumb's namespace segment", () => {
  const pod = {
    ...base,
    resource: { name: "burst-demo" },
    title: "burst-demo",
    resourceKind: "Pod",
    namespace: "k8s-gui-test",
  };
  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: null,
    },
  ];

  function place(ui: ReactNode) {
    return wrap(
      <>
        {ui}
        <LocationProbe />
      </>,
      "/c/prod/pods/k8s-gui-test/burst-demo"
    );
  }

  const where = () => screen.getByTestId("location").textContent;
  const segment = () => screen.getByTitle(/k8s-gui-test/);

  beforeEach(() => {
    useClusterStore.setState({ currentContext: null, currentNamespace: "" });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "trail",
          context: null,
          namespace: "",
          href: "/c/prod/pods/k8s-gui-test/burst-demo",
          missing: false,
        },
      ],
      activeId: "trail",
      pendingHref: null,
    });
  });

  it("narrows this tab and opens the list on a plain click", async () => {
    await place(
      <ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />
    );
    await userEvent.click(segment());
    expect(useClusterStore.getState().currentNamespace).toBe("k8s-gui-test");
    await vi.waitFor(() => expect(where()).toBe("/c/prod/pods"));
  });

  it("carries the namespace into the tab a middle click opens", async () => {
    await place(
      <ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />
    );
    // Testing Library has no `auxClick` helper; React binds `onAuxClick`
    // to the native `auxclick` event, so dispatch that one.
    fireEvent(
      segment(),
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      })
    );
    const { tabs: open, activeId } = useScopeTabStore.getState();
    expect(open).toHaveLength(2);
    expect(open[1]).toMatchObject({
      namespace: "k8s-gui-test",
      href: "/c/prod/pods",
    });
    // Behind, like the browser: the reader is still reading the pod.
    expect(activeId).toBe("trail");
    expect(useClusterStore.getState().currentNamespace).toBe("");
  });

  it("says it narrows the tab only while that is true", async () => {
    const { unmount } = await place(
      <ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />
    );
    expect(segment()).toHaveAccessibleName(
      "Show Pods in k8s-gui-test: narrows this tab to that namespace"
    );
    unmount();

    useClusterStore.setState({ currentNamespace: "k8s-gui-test" });
    await place(
      <ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />
    );
    expect(segment()).toHaveAccessibleName("Show Pods in k8s-gui-test");
  });

  /**
   * A ReplicaSet's parent is a Deployment and Helm's list keeps a namespace
   * filter this scope does not drive, so there is no list to narrow. The
   * scope is still the segment's to give, and giving it must not throw the
   * reader off the page they are reading to do it.
   */
  it("hands over the scope in place when there is no list to narrow", async () => {
    await place(
      <ResourceDetailLayout
        {...pod}
        resourceKind="ReplicaSet"
        listLink={null}
        namespaceLink={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    await userEvent.click(segment());
    expect(useClusterStore.getState().currentNamespace).toBe("k8s-gui-test");
    expect(where()).toBe("/c/prod/pods/k8s-gui-test/burst-demo");
  });

  it("is plain text once that scope is the one the tab already holds", async () => {
    useClusterStore.setState({ currentNamespace: "k8s-gui-test" });
    await place(
      <ResourceDetailLayout
        {...pod}
        resourceKind="ReplicaSet"
        listLink={null}
        namespaceLink={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    expect(screen.getByText("k8s-gui-test")).toBeInTheDocument();
    expect(screen.queryByTitle(/k8s-gui-test/)).toBeNull();
  });
});

describe("DetailError says a read it could not do the way every unread is said", () => {
  /**
   * Shot r5-74: a refused GET drew a red "Could not read this Deployment"
   * over an amber lock box asking "What is this Deployment?". Red is the
   * cluster's or a write's; fails if the sentence is said twice or in red.
   */
  it("says 'could not read' once, in the warn box, never in red", async () => {
    await wrap(
      <DetailError
        error={
          new Error(
            'deployments.apps "api" is forbidden: User "system:serviceaccount:team:x" cannot get resource "deployments" in API group "apps" in the namespace "team"'
          )
        }
        resourceKind="Deployment"
        onBack={() => {}}
      />
    );

    const said = screen.getAllByText("Could not read this Deployment");
    expect(said).toHaveLength(1);
    expect(said[0].closest('[data-read="refused"]')).not.toBeNull();
    expect(screen.queryByText("What is this Deployment?")).toBeNull();
    expect(document.querySelector(".text-err")).toBeNull();
  });

  /**
   * The same page had no header, breadcrumbs or way back to its list while
   * the list beside it held the object. Fails if a failed read with nothing
   * held drops the header, which names the object from its address.
   */
  it("keeps the header, named from the address, over a read that failed", async () => {
    await renderWithRouter(
      <ResourceDetailLayout
        {...base}
        resource={undefined}
        title=""
        resourceKind="Deployment"
        error={new Error("500 from get")}
        activeTab="overview"
        tabs={overview}
      />,
      {
        at: "/c/prod/deployments/argocd/argocd-repo-server",
        route: "/c/$cluster/deployments/$namespace/$name",
      }
    );
    expect(screen.getByText("argocd-repo-server")).toBeInTheDocument();
    expect(screen.getByText("Could not read this Deployment")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Try the read again/ })
    ).toBeVisible();
  });

  /**
   * Shot r5-74 with the list's row drawn: its own read and the one that
   * finds what governs it both failed, and the chip read a clean Ready beside
   * a list row saying "1 problem". Fails if the chip over a stale object
   * does not carry the row's problem.
   */
  /**
   * The Overview and the status bar counted the node autoscaler's
   * TooManyReplicas; the autoscaler's own page said only "219d old" with one
   * amber condition row. Fails if an object's own page does not lead with a
   * finding the shell holds against it, in its chip and its findings.
   */
  it("leads an autoscaler's page with the finding the shell counts against it", async () => {
    shellItems.items = [
      {
        key: "hpa",
        tone: "warn",
        kind: "HorizontalPodAutoscaler",
        name: "node",
        namespace: "realtime-gateway",
        reason: "TooManyReplicas",
        detail: null,
        opens: { kind: "Rollout", name: "node", namespace: "realtime-gateway" },
      },
    ];
    try {
      await wrap(
        <ResourceDetailLayout
          {...base}
          resource={{ name: "node" }}
          title="node"
          namespace="realtime-gateway"
          resourceKind="HorizontalPodAutoscaler"
          statusBadge={<span>Active</span>}
          activeTab="overview"
          tabs={overview}
        />
      );
      const chip = document.querySelector('[data-problem="warn"]');
      expect(chip).toHaveAttribute("title", "TooManyReplicas");
      expect(screen.getByTestId("findings-block")).toHaveTextContent(
        "TooManyReplicas"
      );
    } finally {
      shellItems.items = [];
    }
  });

  it("carries the list row's problem over an object its own read could not answer for", async () => {
    shellItems.items = [
      {
        tone: "warn",
        kind: "HorizontalPodAutoscaler",
        reason: "TooManyReplicas",
        detail: null,
        opens: {
          kind: "Deployment",
          name: "argocd-repo-server",
          namespace: "argocd",
        },
      },
    ];
    try {
      await wrap(
        <ResourceDetailLayout
          {...base}
          resource={{ name: "argocd-repo-server" }}
          title="argocd-repo-server"
          namespace="argocd"
          resourceKind="Deployment"
          statusBadge={<span>Ready</span>}
          activeTab="overview"
          tabs={overview}
          freshness={{
            dataUpdatedAt: Date.now() - 30_000,
            slowed: false,
            paused: false,
            everyMs: 5000,
            stale: true,
            slowRead: false,
            failure: new Error("403 from get"),
            waitingSince: null,
          }}
        />
      );
      const chip = document.querySelector('[data-problem="warn"]');
      // The lone "1" is the mark a narrow cell shows instead, hidden here by CSS.
      expect(chip).toHaveTextContent(/^1 problem1·Ready$/);
      expect(chip).toHaveAttribute("title", "TooManyReplicas");
    } finally {
      shellItems.items = [];
    }
  });

  /** Fails if the stale line over an object kept from an earlier answer offers no way to ask again. */
  it("offers to read again over the object an earlier answer left", async () => {
    const onRetry = vi.fn();
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        onRetry={onRetry}
        freshness={{
          dataUpdatedAt: Date.now() - 30_000,
          slowed: false,
          paused: false,
          everyMs: 5000,
          stale: true,
          slowRead: false,
          failure: new Error("500 from get"),
          waitingSince: null,
        }}
      />
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Try the read again/ })
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

/**
 * The alert the reader arrived from is drawn beside what the app read
 * itself — including on the two states that are the whole reason the
 * feature exists: an object this cluster does not have, and one it has not
 * finished reading. The banner was mounted below both early returns, so on
 * exactly those pages it showed nothing.
 */
describe("the alert a reader arrived from survives the states below it", () => {
  const ALERT = `[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
Started: 2026-09-10 03:14:22 UTC`;

  beforeEach(() => {
    useAlertArrivalStore.setState({
      reading: parseAlert(ALERT),
      at: {
        context: null,
        kind: "Pod",
        name: "payments-7b6d9c5f4-x8k2p",
        namespace: "shop",
      },
    });
  });

  const props = {
    ...base,
    resourceKind: "Pod",
    title: "payments-7b6d9c5f4-x8k2p",
    namespace: "shop",
    tabs: [],
    activeTab: "overview",
  };

  it("shows it on the page that could not read the object", async () => {
    await wrap(
      <ResourceDetailLayout
        {...props}
        resource={null}
        error={new Error("pods is forbidden")}
      />
    );
    expect(screen.getByText(/KubePodCrashLooping/)).toBeVisible();
  });

  it("shows it while the object is still being read", async () => {
    await wrap(<ResourceDetailLayout {...props} resource={null} isLoading />);
    expect(screen.getByText(/KubePodCrashLooping/)).toBeVisible();
  });

  /** The alert named the registry's Pod; a custom kind called Pod is another object. */
  it("does not show it on a custom resource that only shares the kind's name", async () => {
    await wrap(
      <ResourceDetailLayout
        {...props}
        served={{ group: "example.dev", plural: "pods" }}
        resource={null}
        isLoading
      />
    );
    expect(screen.queryByText(/KubePodCrashLooping/)).toBeNull();
  });
});

describe("a detail page whose re-read fails", () => {
  /**
   * During the 502 outage the lists said "read failing" over the rows they
   * kept, while a pod's page kept its pod under "polling" as if every read
   * answered. Fails if the header of a page holding an object its last read
   * could not refresh says anything but that the read is failing, or the
   * page leaves out since when and why, as the peek and the lists say it.
   */
  it("keeps the object and its header says the read is failing", async () => {
    useClusterStore.setState({ isConnected: true });
    const fetch = vi
      .fn<() => Promise<{ name: string }>>()
      .mockResolvedValueOnce({ name: "api-7bcd" })
      .mockRejectedValue(new Error("502 Bad Gateway"));
    let refetch = () => {};
    function Page() {
      const detail = useResourceDetail<{ name: string }>({
        resourceKind: "Pod",
        fetchResource: () => fetch(),
        refresh: false,
      });
      refetch = detail.refetch;
      return (
        <ResourceDetailLayout
          {...base}
          resource={detail.resource}
          isLoading={detail.isLoading}
          error={detail.error}
          resourceKind="Pod"
          title="api-7bcd"
          namespace="shop"
          freshness={detail.freshness}
          tabs={[]}
          activeTab="overview"
        />
      );
    }
    await renderWithRouter(<Page />, {
      at: "/c/prod/pods/shop/api-7bcd",
      route: "/c/$cluster/pods/$namespace/$name",
    });
    expect(await screen.findByText("polling")).toBeInTheDocument();

    await act(async () => refetch());

    expect(await screen.findByText("read failing")).toBeInTheDocument();
    expect(
      screen.getByText(/Could not read Pod api-7bcd\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/502 Bad Gateway/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "api-7bcd"
    );
    expect(screen.queryByText("polling")).toBeNull();
  });
});

describe("ResourceDetailLayout before any read has answered", () => {
  /**
   * Lena's deep link to big-pull drew a blank pane: a page whose read had no
   * answer and no failure yet rendered nothing, and this frame drew "Could
   * not read" for the same state. Fails if a read still to come is drawn as
   * anything but the page's placeholder.
   */
  it("draws its placeholder, not a blank and not a failure", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        resource={undefined}
        activeTab="overview"
        tabs={[]}
      />
    );
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/Could not read/)).toBeNull();
  });

  /**
   * A page that fades in from nothing is a blank pane for as long as a busy
   * window takes to draw its next frame, as Lena's did for three seconds.
   * Fails if the placeholder or the page it gives way to starts transparent.
   */
  it("is drawn opaque from its first frame, and so is the page after it", async () => {
    const { rerender } = await wrapRerenderable(
      <ResourceDetailLayout
        {...base}
        resource={undefined}
        isLoading
        activeTab="overview"
        tabs={[]}
      />
    );
    const faded = () => document.querySelectorAll(".fade-in, .animate-in");
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
    expect(faded()).toHaveLength(0);

    rerender(<ResourceDetailLayout {...base} activeTab="overview" tabs={[]} />);
    expect(screen.queryByTestId("detail-skeleton")).toBeNull();
    expect(faded()).toHaveLength(0);
  });

  /**
   * The skeleton replaced the whole page, so the name, the breadcrumb and
   * Back, all known from the address, vanished until the read answered. Fails
   * if the placeholder stands in for the header instead of sitting under it.
   */
  it("keeps the header with the name and Back while the body loads", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        resource={undefined}
        isLoading
        activeTab="overview"
        tabs={[]}
      />
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "pv-demo"
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
  });
});

describe("a detail page whose object could not be read at all", () => {
  /**
   * The error card named the cause and offered no way out: no page passed a
   * retry. Fails if a failed read has no Read again button, or the button
   * does not ask the page's read once more.
   */
  it("offers to read the object again", async () => {
    const retry = vi.fn();
    await wrap(
      <ResourceDetailLayout
        {...base}
        resource={undefined}
        error={new Error("connection reset")}
        onRetry={retry}
        activeTab="overview"
        tabs={[]}
      />
    );
    expect(screen.getByText(/connection reset/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    expect(retry).toHaveBeenCalled();
  });
});

const overview: DetailTab[] = [
  {
    id: "overview",
    label: "Overview",
    glyph: viewGlyph(Info),
    content: <p>replicas 5 of 5</p>,
  },
];

const ceiling = {
  tone: "warn" as const,
  title: "web-hpa is at its ceiling of 5",
  detail: "The desired replica count is more than the maximum.",
  evidence: [
    { key: "m", label: "memory", from: null, current: "105%", target: "80%" },
  ],
};

/**
 * A green word above an amber cause was the bug: the header said Ready and
 * the reason it was not sat three blocks down. Fails if the chip stops
 * carrying the finding's tone, or the finding moves back under the facts.
 */
describe("ResourceDetailLayout leads with the cause", () => {
  /**
   * The list read "⚠ 1 problem · ✓ Ready" and this header "✓ Ready · ⚠ 1
   * problem", with the word amber. Fails if the mark stops leading in the
   * problem's tone or the quiet word beside it is drawn in any colour.
   */
  it("leads the status chip with the finding's mark and draws the word neutral", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        statusBadge={<span className="text-ok">Ready</span>}
        statusRole="ok"
        findings={[ceiling]}
      />
    );
    const chip = document.querySelector('[data-problem="warn"]');
    // The lone "1" is the mark a narrow cell shows instead, hidden here by CSS.
    expect(chip).toHaveTextContent(/^1 problem1·Ready$/);
    expect(chip?.firstElementChild).toHaveAttribute("data-problem-mark");
    expect(chip?.firstElementChild?.className).toContain("text-warn");
    const word = chip?.querySelector("[data-problem-word]");
    expect(word?.className).toContain("[&_*]:text-fg-mut!");
    expect(word?.className).not.toContain("text-warn");
  });

  it("puts the finding and the metric that caused it before the strip", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        statusBadge={<span>Ready</span>}
        findings={[ceiling]}
      />
    );
    const headline = screen.getByText("web-hpa is at its ceiling of 5");
    const strip = screen.getByRole("tablist");
    expect(
      headline.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByTestId("finding-evidence")).toHaveTextContent(
      "memory 105% against a target of 80%"
    );
  });

  /** Two metrics ran together as "80%cpu 86%"; fails if the separator goes. */
  it("separates the readings of a finding with a middle dot", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        statusBadge={<span>Ready</span>}
        findings={[
          {
            ...ceiling,
            evidence: [
              ...ceiling.evidence,
              {
                key: "c",
                label: "cpu",
                from: null,
                current: "86%",
                target: "80%",
              },
            ],
          },
        ]}
      />
    );
    const [first] = screen.getAllByTestId("finding-evidence");
    expect(first.parentElement).toHaveTextContent(
      "memory 105% against a target of 80% · cpu 86% against a target of 80%"
    );
  });

  it("keeps a healthy object's chip plain", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        statusBadge={<span>Ready</span>}
        findings={[{ ...ceiling, tone: "neutral", evidence: undefined }]}
      />
    );
    expect(document.querySelector("[data-problem]")).toBeNull();
  });

  it("does not paint a failing badge quieter than it already is", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        statusBadge={<span>Failed</span>}
        statusRole="err"
        findings={[ceiling]}
      />
    );
    const word = document.querySelector("[data-problem-word]");
    expect(word).toHaveAttribute("data-problem-word", "loud");
    expect(word?.className).not.toContain("text-fg-mut");
  });
});

/** A page whose events were refused is not live: fails if the header keeps the freshness chip over a read that never answered. */
describe("ResourceDetailLayout says when a read beside the object failed", () => {
  it("replaces the live reading with a partly-unread one naming the read", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        freshness={
          {
            dataUpdatedAt: Date.now(),
            live: true,
            slowed: false,
            stale: false,
            slowRead: false,
          } as never
        }
        unread={["Events"]}
      />
    );
    expect(screen.getByTestId("partly-unread")).toHaveTextContent(
      "partly unread"
    );
    expect(screen.queryByText("live")).toBeNull();
  });

  it("keeps the live reading while every read answered", async () => {
    await wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={overview}
        freshness={
          {
            dataUpdatedAt: Date.now(),
            live: true,
            slowed: false,
            stale: false,
            slowRead: false,
          } as never
        }
        unread={[]}
      />
    );
    expect(screen.queryByTestId("partly-unread")).toBeNull();
    expect(screen.getByText("live")).toBeInTheDocument();
  });
});

describe("ResourceDetailLayout after its object comes back, and while it cannot", () => {
  const freshness = (stale: boolean, failure: unknown = null) => ({
    dataUpdatedAt: Date.now() - 30_000,
    slowed: false,
    paused: false,
    everyMs: 5000,
    stale,
    slowRead: false,
    failure,
    waitingSince: null,
  });
  const hpaItem = {
    tone: "warn",
    kind: "HorizontalPodAutoscaler",
    name: "api",
    namespace: "argocd",
    reason: "api cannot reach what it scales",
    detail: null,
    opens: { kind: "Deployment", name: "api", namespace: "argocd" },
  };

  /**
   * Shots r6-10/11: the object read again, its findings read had not, and
   * the header dropped "1 problem" beside a row still saying it. Fails if
   * the chip floors at the row's problem only while the object is stale.
   */
  it("carries the row's problem whenever its own findings name none", async () => {
    shellItems.items = [hpaItem];
    try {
      await wrap(
        <ResourceDetailLayout
          {...base}
          resource={{ name: "api" }}
          title="api"
          namespace="argocd"
          resourceKind="Deployment"
          statusBadge={<span>Idle</span>}
          findings={[]}
          activeTab="overview"
          tabs={overview}
          freshness={freshness(false)}
        />
      );
      expect(document.querySelector('[data-problem="warn"]')).toHaveAttribute(
        "title",
        "api cannot reach what it scales"
      );
    } finally {
      shellItems.items = [];
    }
  });

  /**
   * Shot r6-12: only each box's own retry cleared it. Fails if the object's
   * one retry leaves a failed part about it to its own timer.
   */
  it("asks every failed part about the object again on the object's one retry", async () => {
    const part = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("etcdserver: request timed out"));
    function Part() {
      useQuery({
        queryKey: ["owned-pods", "Deployment", "argocd", "api", null],
        queryFn: part,
        retry: false,
      });
      return <p>pods</p>;
    }
    await wrap(
      <ResourceDetailLayout
        {...base}
        resource={{ name: "api" }}
        title="api"
        namespace="argocd"
        resourceKind="Deployment"
        onRetry={() => undefined}
        activeTab="overview"
        tabs={[{ ...overview[0], content: <Part /> }]}
        freshness={freshness(true, new Error("500 from get"))}
      />
    );
    await waitFor(() => expect(part).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Try the read again/ })
      ).toBeEnabled()
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Try the read again/ })
    );
    await waitFor(() => expect(part).toHaveBeenCalledTimes(2));
  });

  /**
   * Shots r6-07/08: the peek said "read failing" and the page "partly
   * unread" for one refused GET of the object. Fails if the parts that fail
   * with the object outrank its own failure, or a refusal is not said as one.
   */
  it("says the object's own refusal in the chip, over the parts that fail with it", async () => {
    const refused = new Error('deployments.apps "api" is forbidden');
    await wrap(
      <ResourceDetailLayout
        {...base}
        resource={{ name: "api" }}
        title="api"
        namespace="argocd"
        resourceKind="Deployment"
        activeTab="overview"
        tabs={overview}
        unread={["Pods", "Revisions"]}
        freshness={freshness(true, refused)}
      />
    );
    expect(screen.queryByTestId("partly-unread")).toBeNull();
    expect(screen.getByText("refused")).toBeInTheDocument();
  });

  /** Fails if a part read through an object its own read cannot answer for is not told so, or is told after the object answers. */
  it("tells the parts under it which object they wait on, only while it is unread", async () => {
    function Part() {
      const unread = useObjectUnread();
      return (
        <p data-testid="part">
          {unread ? `waits on ${unread.kind} ${unread.name}` : "reads"}
        </p>
      );
    }
    const props = {
      ...base,
      resource: { name: "api" },
      title: "api",
      namespace: "argocd",
      resourceKind: "Deployment",
      activeTab: "overview",
      tabs: [{ ...overview[0], content: <Part /> }],
    };
    const { rerender } = await wrapRerenderable(
      <ResourceDetailLayout
        {...props}
        freshness={freshness(true, new Error("500 from get"))}
      />
    );
    expect(screen.getByTestId("part")).toHaveTextContent(
      "waits on Deployment api"
    );
    rerender(<ResourceDetailLayout {...props} freshness={freshness(false)} />);
    expect(screen.getByTestId("part")).toHaveTextContent("reads");
  });
});
