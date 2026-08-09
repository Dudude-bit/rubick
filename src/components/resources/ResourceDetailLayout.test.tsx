import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Info } from "lucide-react";

import { SectionHeader } from "@/components/ui/section";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { ResourceDetailLayout } from "./ResourceDetailLayout";
import {
  countMark,
  kindGlyph,
  liveMark,
  severityMark,
  viewGlyph,
  type DetailTab,
} from "./detail-tab";

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** Where a click landed, read out of the router rather than guessed at. */
function LocationProbe() {
  const { pathname } = useLocation();
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
 * A surface tab reclaims the page's height by hiding the blocks the page
 * renders above the tab strip. That is a fair trade only while some other tab
 * still shows them — on a page whose every tab is a surface it is not a trade
 * at all, and PersistentVolume lost its capacity, binding and reclaim policy
 * outright until this was caught.
 */
describe("ResourceDetailLayout with only surface tabs", () => {
  it("keeps the page's own blocks visible when no tab would ever show them", () => {
    wrap(
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
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    expect(screen.getByText("capacity 2Gi").parentElement).not.toHaveClass(
      "hidden"
    );
  });

  it("still hides them on a surface tab when another tab shows them", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="logs"
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
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    // Asserted on the wrapper's class rather than on visibility: `hidden` is a
    // Tailwind utility and jsdom loads no stylesheet, so `toBeVisible` cannot
    // see it. Kept mounted either way — dialogs a page hangs here portal to
    // the body and have to survive the tab that opened them.
    expect(screen.getByText("capacity 2Gi").parentElement).toHaveClass(
      "hidden"
    );
  });

  it("shows them again on the sections tab", () => {
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
            id: "logs",
            label: "Logs",
            glyph: viewGlyph(Info),
            kind: "surface",
            content: null,
          },
        ]}
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    expect(screen.getByText("capacity 2Gi").parentElement).not.toHaveClass(
      "hidden"
    );
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

  it("keeps a session alive through a trip to another tab and back", () => {
    mounted.mockClear();
    const { rerender } = wrap(<ResourceDetailLayout {...withShell("shell")} />);
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <ResourceDetailLayout {...withShell("overview")} />
      </MemoryRouter>
    );
    // Still in the DOM, merely off the screen: `hidden` is what a reader loses
    // when they click away, and the session is not theirs to lose with it.
    expect(screen.getByText("attached to app")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ResourceDetailLayout {...withShell("shell")} />
      </MemoryRouter>
    );
    // The number that matters: a second mount would be a second `openPodShell`
    // and a dead prompt where the reader left a live one.
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("does not mount a surface nobody has opened", () => {
    mounted.mockClear();
    wrap(<ResourceDetailLayout {...withShell("overview")} />);
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

  it("puts the actions on the tab strip's row", () => {
    withActions("overview");
    const row = screen.getByRole("tablist").parentElement;
    expect(row).toContainElement(
      screen.getByRole("button", { name: "Delete" })
    );
  });

  it("keeps them off the header, which is now identity only", () => {
    withActions("overview");
    const header = screen
      .getByRole("heading", { level: 1 })
      .closest("div")?.parentElement;
    expect(header).not.toContainElement(
      screen.getByRole("button", { name: "Delete" })
    );
  });

  // The header used to drop the age and the qualifying badges on a full-height
  // tab, to buy back the second row it needed for the actions. It is one row
  // either way now, so there is nothing to buy and nothing to drop — and a
  // header that restructures itself when the reader clicks Logs reads as the
  // page reloading.
  it("says the same things on a full-height tab as on any other", () => {
    withActions("yaml", "surface");
    expect(screen.getByText(/old/)).toBeInTheDocument();
  });
});

/**
 * The strip is a heading. Whatever a tab opens with does not get to say the
 * word the reader just clicked, and no block gets to say the kind the
 * breadcrumb and the title already carry.
 */
describe("ResourceDetailLayout captions", () => {
  it("drops a block heading that only repeats the tab label", () => {
    wrap(
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

  it("keeps the count the strip does not carry, with its noun", () => {
    wrap(
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

  it("drops a block heading that only repeats the kind", () => {
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
        ]}
      >
        <SectionHeader title="PersistentVolume" />
      </ResourceDetailLayout>
    );
    expect(
      screen.queryByRole("heading", { name: "PersistentVolume" })
    ).not.toBeInTheDocument();
  });

  it("leaves a heading that says something new", () => {
    wrap(
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

  it("draws one for every tab, and hides it from the accessible name", () => {
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
  it("tints a tab that names a kind, active or not", () => {
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
  it("leaves a tab that names a view untinted", () => {
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

  it("says how many a collection holds, so an empty one needs no click", () => {
    strip(countMark(0));
    expect(screen.getByRole("tab", { name: /Containers/ })).toHaveTextContent(
      "Containers0"
    );
  });

  it("puts a severity dot's meaning into words", () => {
    strip(severityMark("err", "1 of 4 failing"));
    expect(
      screen.getByRole("tab", { name: "Containers — 1 of 4 failing" })
    ).toBeInTheDocument();
  });

  it("does the same for a live session", () => {
    strip(liveMark("session attached to app"));
    expect(
      screen.getByRole("tab", { name: "Containers — session attached to app" })
    ).toBeInTheDocument();
  });

  /**
   * The only animated thing in the strip, which is what lets it mean one
   * thing — and it stops for a reader who asked motion to stop.
   */
  it("animates the live dot and nothing else, and not under reduced motion", () => {
    strip(liveMark("session attached to app"));
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

  it("links to the list route the sidebar uses", () => {
    wrap(<ResourceDetailLayout {...base} activeTab="overview" tabs={tabs} />);
    expect(
      screen.getByRole("link", { name: "persistentvolumes" })
    ).toHaveAttribute("href", "/storage/persistentvolumes");
  });

  it("is plain text when there is nowhere to go", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        resourceKind="ReplicaSet"
        listUrl={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    expect(screen.getByText("replicasets")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "replicasets" })).toBeNull();
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

  function place(ui: React.ReactNode) {
    return render(
      <MemoryRouter initialEntries={["/pods/k8s-gui-test/burst-demo"]}>
        {ui}
        <LocationProbe />
      </MemoryRouter>
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
          href: "/pods/k8s-gui-test/burst-demo",
          missing: false,
        },
      ],
      activeId: "trail",
      pendingHref: null,
    });
  });

  it("narrows this tab and opens the list on a plain click", async () => {
    place(<ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />);
    await userEvent.click(segment());
    expect(useClusterStore.getState().currentNamespace).toBe("k8s-gui-test");
    expect(where()).toBe("/workloads/pods");
  });

  it("carries the namespace into the tab a middle click opens", () => {
    place(<ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />);
    // Testing Library has no `auxClick` helper; React binds `onAuxClick`
    // to the native `auxclick` event, so dispatch that one.
    fireEvent(
      segment(),
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    );
    const { tabs: open, activeId } = useScopeTabStore.getState();
    expect(open).toHaveLength(2);
    expect(open[1]).toMatchObject({
      namespace: "k8s-gui-test",
      href: "/workloads/pods",
    });
    // Behind, like the browser: the reader is still reading the pod.
    expect(activeId).toBe("trail");
    expect(useClusterStore.getState().currentNamespace).toBe("");
  });

  it("says it narrows the tab only while that is true", () => {
    const { unmount } = place(
      <ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />
    );
    expect(segment()).toHaveAccessibleName(
      "Show pods in k8s-gui-test — narrows this tab to that namespace"
    );
    unmount();

    useClusterStore.setState({ currentNamespace: "k8s-gui-test" });
    place(<ResourceDetailLayout {...pod} activeTab="overview" tabs={tabs} />);
    expect(segment()).toHaveAccessibleName("Show pods in k8s-gui-test");
  });

  /**
   * A ReplicaSet's parent is a Deployment and Helm's list keeps a namespace
   * filter this scope does not drive, so there is no list to narrow. The
   * scope is still the segment's to give, and giving it must not throw the
   * reader off the page they are reading to do it.
   */
  it("hands over the scope in place when there is no list to narrow", async () => {
    place(
      <ResourceDetailLayout
        {...pod}
        resourceKind="ReplicaSet"
        listUrl={null}
        namespaceUrl={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    await userEvent.click(segment());
    expect(useClusterStore.getState().currentNamespace).toBe("k8s-gui-test");
    expect(where()).toBe("/pods/k8s-gui-test/burst-demo");
  });

  it("is plain text once that scope is the one the tab already holds", () => {
    useClusterStore.setState({ currentNamespace: "k8s-gui-test" });
    place(
      <ResourceDetailLayout
        {...pod}
        resourceKind="ReplicaSet"
        listUrl={null}
        namespaceUrl={null}
        activeTab="overview"
        tabs={tabs}
      />
    );
    expect(screen.getByText("k8s-gui-test")).toBeInTheDocument();
    expect(screen.queryByTitle(/k8s-gui-test/)).toBeNull();
  });
});
