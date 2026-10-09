import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SCOPE_PICKER_OPEN } from "@/lib/read-deadline";

/** What the authorizer answers about each namespace, per test. */
const nsAccess = vi.hoisted(() => ({
  answers: [] as Array<{
    namespace: string;
    allowed: boolean | null;
    otherLists?: boolean | null;
  }>,
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => []),
    checkNamespaceAccess: vi.fn(async () => nsAccess.answers),
  },
}));

/** What the namespace picker is looking at, per test. */
const summary = vi.hoisted(() => ({
  namespaces: [] as Array<{
    name: string;
    podCount: number;
    problems: {
      total: number;
      complete: boolean;
      worst: "err" | "warn" | null;
    } | null;
  }>,
  podCount: 0 as number | null,
  namespaceList: "listed" as "listed" | "refused" | "failed" | "pending",
}));

/** Whether each render of the picker asked for the cluster-wide counts. */
const counted = vi.hoisted(() => ({
  enabled: [] as Array<boolean | undefined>,
}));

vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: ({ enabled }: { enabled?: boolean } = {}) => {
    counted.enabled.push(enabled);
    return summary;
  },
}));

import { commands } from "@/lib/commands";
import { SCOPE_LIMIT, scopeLabel, wireNamespace } from "@/lib/namespace-scope";
import { renderWithRouter } from "@/test/render";
import { ScopeTabs } from "./ScopeTabs";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore, type ScopeTab } from "@/stores/scopeTabStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";
import { useKeptShellStore } from "@/stores/keptShellStore";

import { translate } from "@/i18n";
import type { ContextInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const tab = (over: Partial<ScopeTab> = {}): ScopeTab => ({
  id: "t1",
  context: "k3d-dev",
  namespace: "",
  href: "/",
  missing: false,
  ...over,
});

async function mount(at = "/c/k3d-dev") {
  const { router } = await renderWithRouter(<ScopeTabs />, { at, route: "$" });
  return router;
}

const tabs = () => screen.getAllByRole("tab");

/**
 * jsdom lays nothing out, so the strip is given a room `room` pixels wide,
 * each part it may cut 7px a character up to the width written on it, and
 * each tab its parts and 100px of dot, slashes and close button.
 */
function layout(room: number) {
  const cut = (part: Element) => {
    const natural = (part.textContent ?? "").length * 7;
    const max = parseFloat((part as HTMLElement).style.maxWidth);
    return Number.isNaN(max) ? natural : Math.min(natural, max);
  };
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-cut")
        ? cut(this)
        : this.hasAttribute("data-scope-tab")
          ? 100 +
            [...this.querySelectorAll("[data-cut]")].reduce(
              (sum, part) => sum + cut(part),
              0
            )
          : 0;
      return { width, height: 0, top: 0, left: 0, right: width } as DOMRect;
    });
  const client = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-scope-room") ? room : 0;
    });
  return () => {
    rect.mockRestore();
    client.mockRestore();
  };
}

beforeEach(() => {
  localStorage.clear();
  summary.namespaces = [];
  summary.podCount = 0;
  summary.namespaceList = "listed";
  useNamespaceRecencyStore.setState({ recent: {} });
  nsAccess.answers = [];
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({
    contexts: [],
    currentContext: "k3d-dev",
    currentNamespace: "",
    namespaceScope: [],
    isConnected: true,
    isLoading: false,
    isAuthenticating: false,
    error: null,
    pendingContext: null,
  });
});

describe("what a tab says", () => {
  it("drops the cluster name while the strip holds one cluster", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/c/k3d-dev" }),
        tab({ id: "b", href: "/c/k3d-dev/pods" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    await mount();

    // The sidebar has just said it and the dot still guards the mistake,
    // so the name is not worth the width it would take from the route.
    expect(screen.queryByText("k3d-dev")).not.toBeInTheDocument();
    expect(within(tabs()[0]).getByText("Overview")).toBeInTheDocument();
    expect(within(tabs()[1]).getByText("Pods")).toBeInTheDocument();
  });

  it("names every cluster the moment a second one is open", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "prod-eu" })],
      activeId: "a",
      pendingHref: null,
    });
    await mount();

    expect(screen.getByText("k3d-dev")).toBeInTheDocument();
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
  });

  it("keeps the route on every tab, which is what tells them apart", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/c/k3d-dev/pods" }),
        tab({ id: "b", href: "/c/k3d-dev/pods/kube-system/coredns-abc" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    await mount();

    expect(within(tabs()[0]).getByText("Pods")).toBeInTheDocument();
    expect(within(tabs()[1]).getByText("coredns-abc")).toBeInTheDocument();
  });

  it("carries the whole label in the accessible name the strip shortens", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", namespace: "kube-system", href: "/c/k3d-dev/nodes" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    useClusterStore.setState({
      currentNamespace: "kube-system",
      namespaceScope: ["kube-system"],
    });
    await mount();

    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "k3d-dev · kube-system · Nodes"
    );
  });

  /**
   * Closing a tab ends the shell it keeps, so the tab says it keeps one,
   * parked or not. Fails if a tab with a running shell looks like any other.
   */
  it("says which tab keeps a running shell, and that closing it ends the shell", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/c/k3d-dev/pods" }),
        tab({ id: "b", href: "/c/k3d-dev/pods/shop/cart-4f68h" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    useKeptShellStore.setState({
      shells: [
        {
          id: "term-1",
          tab: "b",
          context: "k3d-dev",
          namespace: "shop",
          pod: "cart-4f68h",
          container: "app",
        },
      ],
    });
    await mount();

    expect(tabs()[0].getAttribute("aria-label")).not.toMatch(/shell/);
    expect(tabs()[1]).toHaveAttribute(
      "aria-label",
      "k3d-dev · all namespaces · cart-4f68h. A shell is running in cart-4f68h/app. Closing this tab ends it."
    );
    useKeptShellStore.setState({ shells: [] });
  });

  /**
   * With five tabs Dana's shell tab had no close button: squeezed to its
   * floor, the shell glyph pushed the button past the edge the tab clipped
   * at. Fails if anything between a close button and its tab can clip it,
   * or if the tab that keeps a shell gets no room for the glyph.
   */
  it("keeps every tab's close button out of what a squeezed tab cuts off, at five tabs", async () => {
    useScopeTabStore.setState({
      tabs: ["a", "b", "c", "d", "e"].map((id) =>
        tab({ id, href: `/c/k3d-dev/pods/shop/cart-${id}` })
      ),
      activeId: "c",
      pendingHref: null,
    });
    useKeptShellStore.setState({
      shells: [
        {
          id: "term-1",
          tab: "c",
          context: "k3d-dev",
          namespace: "shop",
          pod: "cart-c",
          container: "app",
        },
      ],
    });
    await mount();

    const clips =
      /\b(overflow-hidden|overflow-x-hidden|overflow-clip|truncate)\b/;
    for (const each of tabs()) {
      const close = within(each).getByRole("button", { name: /^Close / });
      for (let at: HTMLElement | null = close; at; at = at.parentElement) {
        expect(at.className).not.toMatch(clips);
        if (at === each) break;
      }
    }

    await userEvent.click(
      within(tabs()[2]).getByRole("button", { name: /^Close / })
    );
    expect(useScopeTabStore.getState().tabs.map((each) => each.id)).toEqual([
      "a",
      "b",
      "d",
      "e",
    ]);
    useKeptShellStore.setState({ shells: [] });
  });

  it("has no native title left to cover the pickers", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
    await mount();
    expect(tabs()[0]).not.toHaveAttribute("title");
  });
});

describe("a strip with more tabs than room", () => {
  const ROUTES = ["pods", "deployments", "services", "events", "nodes"];
  const six = (active: string) => {
    useScopeTabStore.setState({
      tabs: [
        ...ROUTES.map((route, index) =>
          tab({ id: `t${index}`, href: `/c/k3d-dev/${route}` })
        ),
        tab({ id: "cart", href: "/c/k3d-dev/pods/shop/cart-667846ff79-4f68h" }),
      ],
      activeId: active,
      pendingHref: null,
    });
  };
  /** The strip and its menu are 1100px: four tabs at their floors and the menu. */
  const roomOf1100 = () => layout(1100);
  /** The menu's tabs stay mounted to be measured, out of sight: what the strip draws is the rest. */
  const drawn = () =>
    screen
      .getAllByRole("tab")
      .filter((each) => !each.hasAttribute("data-overflow"));
  const inStrip = () =>
    drawn().map((each) => each.getAttribute("aria-label")?.split(" · ").at(-1));
  const menuItems = async () => {
    await userEvent.click(screen.getByRole("button", { name: /do not fit/ }));
    return screen.getAllByRole("menuitem");
  };

  /**
   * Dana at 1440 with six tabs: the fifth sat cut under Search with no
   * close button and the sixth was off screen, with nothing saying so.
   * Fails if a tab is drawn cut, or one that does not fit is not offered by
   * name, or a tab in the strip has no close button.
   */
  it("shows each tab whole in the strip or by name in the menu", async () => {
    six("t0");
    const width = roomOf1100();
    try {
      await mount();
      expect(inStrip()).toEqual(["Pods", "Deployments", "Services", "Events"]);
      for (const each of drawn())
        expect(
          within(each).getByRole("button", { name: /^Close / })
        ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "2 more tabs do not fit" })
      ).toHaveTextContent("2 more");
      expect((await menuItems()).map((item) => item.textContent)).toEqual([
        "All namespaces /Nodes",
        "All namespaces /cart-667846ff79-4f68h",
      ]);
    } finally {
      width();
    }
  });

  /**
   * Dana's menu read "All namespa… / recommendations…4b65d-bjc2c" beside a
   * whole "shop / recommendations-685f64b65d-bjc2c". Fails if an entry's
   * scope may give up width, or its object name may not.
   */
  it("keeps each menu entry's scope whole and cuts only its object name", async () => {
    six("t0");
    const width = roomOf1100();
    try {
      await mount();
      const cart = (await menuItems()).at(-1)!;
      const scope = within(cart).getByText(/^All namespaces/);
      expect(scope).toHaveClass("flex-none");
      expect(scope).not.toHaveClass("truncate");
      expect(cart.querySelector("[data-route-name]")).toHaveClass("min-w-0");
    } finally {
      width();
    }
  });

  /**
   * Dana's deep link landed on the cart tab, which sat half under Search
   * with no tab on screen marked open. Fails if the open tab can be the one
   * the strip leaves out, or a tab picked from the menu does not open.
   */
  it("keeps the open tab in the strip, and opens the one picked from the menu", async () => {
    six("cart");
    const width = roomOf1100();
    try {
      await mount();
      expect(inStrip()).toEqual([
        "Pods",
        "Deployments",
        "Services",
        "cart-667846ff79-4f68h",
      ]);
      const items = await menuItems();
      await userEvent.click(items[0]);
      expect(useScopeTabStore.getState().activeId).toBe("t3");
      expect(inStrip()).toContain("Events");
    } finally {
      width();
    }
  });

  /**
   * Lena at 1024 with payments-578dcb4559-rf746 open read the tab beside it
   * as "team-check… / Обзор", blank room before its close button. Fails if
   * a namespace short enough to read whole is cut while the long object name
   * beside it still has characters to give, or the long name is cut under
   * the floor that keeps its start and its generated end.
   */
  it("cuts the long object name and never the short namespace beside it", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({
          id: "pay",
          href: "/c/k3d-dev/pods/shop/payments-578dcb4559-rf746",
        }),
        tab({ id: "home", namespace: "team-checkout", href: "/c/k3d-dev" }),
      ],
      activeId: "pay",
      pendingHref: null,
    });
    useClusterStore.setState({
      currentNamespace: "shop",
      namespaceScope: ["shop"],
    });
    const restore = layout(500);
    try {
      await mount();
      const [pay, home] = tabs();
      const scopeOf = (each: HTMLElement) =>
        within(each).getByText(/^(shop|team-checkout)$/);
      expect(scopeOf(home).style.maxWidth).toBe("");
      expect(scopeOf(pay).style.maxWidth).toBe("");
      const name = pay.querySelector<HTMLElement>("[data-route-name]")!;
      expect(parseFloat(name.style.maxWidth)).toBeLessThan(
        "payments-578dcb4559-rf746".length * 7
      );
      expect(parseFloat(name.style.maxWidth)).toBeGreaterThanOrEqual(72);
      expect(home).not.toHaveAttribute("data-overflow");
    } finally {
      restore();
    }
  });

  /**
   * Dana clicked Events and the shell tab beside it dropped into the menu,
   * so her next click on its place opened cart-crjnn. Fails if opening a
   * tab that is already in the strip changes which tabs the strip shows.
   */
  it("keeps the same tabs in the strip when one of them is opened", async () => {
    six("cart");
    const width = roomOf1100();
    try {
      await mount();
      const before = inStrip();
      await userEvent.click(screen.getByRole("tab", { name: /Pods$/ }));
      expect(useScopeTabStore.getState().activeId).toBe("t0");
      expect(inStrip()).toEqual(before);
    } finally {
      width();
    }
  });

  /**
   * Two cart pods read "cart-6678…" and "cart-6678…". Fails if a cut
   * object route can lose the end that tells two pods of one ReplicaSet
   * apart, or if the name stops being in the text once, whole.
   */
  it("keeps the generated end of an object route it cuts", async () => {
    six("cart");
    await mount();
    const name = screen
      .getByRole("tab", { name: /cart-667846ff79-4f68h/ })
      .querySelector("[data-route-name]")!;
    const [head, cut, end] = [...name.children] as HTMLElement[];
    expect(name).toHaveClass("font-mono");
    expect(head).toHaveTextContent(/^cart-667846ff79-4f68h$/);
    expect(cut).toHaveAttribute("aria-hidden", "true");
    expect(end).toHaveAttribute("aria-hidden", "true");
    expect(end.style.width).toContain("ch");
    expect(end.firstElementChild).toHaveAttribute(
      "data-name",
      "cart-667846ff79-4f68h"
    );
    expect(
      screen
        .getByRole("tab", { name: /Pods$/ })
        .querySelector("[data-route-name]")
    ).toBeNull();
  });
});

describe("watching several namespaces at once", () => {
  const draw = async (scope: string[], at?: string) => {
    summary.namespaces = Array.from({ length: SCOPE_LIMIT + 2 }, (_, i) => ({
      name: `ns-${i}`,
      podCount: 1,
      problems: null,
    }));
    // The pair the store itself keeps: `tabScope` reads a tab whose two
    // fields disagree as one an older build parked, and hands back the older
    // field — so a test that sets an impossible pair tests nothing real.
    useClusterStore.setState({
      currentNamespace: wireNamespace(scope),
      namespaceScope: scope,
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
    return mount(at);
  };

  /** Marco's "what can I do here", asked where the namespace is chosen. */
  it("offers what the reader may do in the namespace they are on", async () => {
    const user = userEvent.setup();
    await draw(["ns-0"]);
    await openPicker(user);
    expect(
      screen.getByRole("link", { name: "What can I do in ns-0?" })
    ).toHaveAttribute("href", "/c/k3d-dev/my-access");
  });

  it("names the whole selection where a reader cannot see the strip", async () => {
    await draw(["ns-0", "ns-1"]);
    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "k3d-dev · ns-0, ns-1 · Overview"
    );
  });

  const scope = () => useClusterStore.getState().namespaceScope;
  const rowFor = (name: string) =>
    screen.getByRole("option", { name: new RegExp(`^${name},`) });

  /** Opens the namespace list on the one tab in the strip. */
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(tabs()[0]).getByText(scopeLabel(scope(), t)));
    return screen.getByRole("listbox", { name: "Namespaces" });
  };

  /**
   * The frequent job, and the one every other gesture here is measured
   * against: a plain click still swaps the window onto one namespace and
   * shuts the list. Would break if adding several ever became the default.
   */
  /**
   * The counts are the whole cluster's, which a namespace-only token is
   * refused. Fails if the shut picker keeps asking for them.
   */
  it("asks for the cluster-wide counts only while the list is open", async () => {
    const user = userEvent.setup();
    await draw(["ns-0"]);
    expect(counted.enabled.at(-1)).toBe(false);

    await openPicker(user);
    expect(counted.enabled.at(-1)).toBe(true);
  });

  /** Lena reopened the picker to find "lena" still typed and offered as a name not in the list; fails if a pick leaves its filter for the next open. */
  it("opens with an empty filter after a pick shut it", async () => {
    const user = userEvent.setup();
    await draw(["ns-0"]);
    await openPicker(user);
    await user.keyboard("ns-3{Enter}");
    expect(scope()).toEqual(["ns-3"]);

    await openPicker(user);
    expect(
      screen.getByRole("combobox", { name: t("action", "filterNamespaces") })
    ).toHaveValue("");
  });

  /**
   * A pod page under a scope that does not hold its namespace is a tab
   * naming one namespace over an object in another. Fails if a pick that
   * leaves the object out keeps its page, or one that keeps it in leaves it.
   */
  it("sends an object page the picked scope leaves out to its list", async () => {
    const user = userEvent.setup();
    const router = await draw(["ns-0"], "/c/k3d-dev/pods/ns-0/api-1");
    await openPicker(user);
    await user.keyboard("{Control>}");
    await user.click(rowFor("ns-1"));
    await user.keyboard("{/Control}");
    expect(router.state.location.pathname).toBe("/c/k3d-dev/pods/ns-0/api-1");

    await user.click(rowFor("ns-3"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/k3d-dev/pods")
    );
    expect(scope()).toEqual(["ns-3"]);
  });

  it("replaces the selection on a plain click and shuts the list", async () => {
    const user = userEvent.setup();
    await draw(["ns-0", "ns-1"]);
    await openPicker(user);

    await user.click(rowFor("ns-3"));

    expect(scope()).toEqual(["ns-3"]);
    expect(
      screen.queryByRole("listbox", { name: "Namespaces" })
    ).not.toBeInTheDocument();
  });

  /**
   * The other gesture, and the box that stands in for it. Would break if the
   * modifier or the checkbox started replacing the selection instead of
   * joining it — which is four namespaces thrown away on a gesture that asked
   * to keep them.
   */
  it("adds on a modifier click and on the box, and keeps the list open", async () => {
    const user = userEvent.setup();
    await draw(["ns-0"]);
    await openPicker(user);

    await user.keyboard("{Control>}");
    await user.click(rowFor("ns-1"));
    await user.keyboard("{/Control}");
    expect(scope()).toEqual(["ns-0", "ns-1"]);

    const box = rowFor("ns-2").querySelector("[data-add]");
    await user.click(box as Element);
    expect(scope()).toEqual(["ns-0", "ns-1", "ns-2"]);

    expect(screen.getByRole("listbox", { name: "Namespaces" })).toBeVisible();
  });

  /**
   * The reader from #137 stands in several namespaces on a cluster of many,
   * and came to the list to turn one off. The ones already selected float to
   * the top so they are found and deselected at a glance, instead of hunting
   * them out of sixty. Would break if the list went back to raw summary order.
   */
  it("floats the selected namespaces to the top of the list", async () => {
    const user = userEvent.setup();
    // ns-3 and ns-4 are picked, and sit in the middle of the summary order.
    await draw(["ns-3", "ns-4"]);
    const list = await openPicker(user);

    const label = (option: HTMLElement) => {
      const name = option.getAttribute("aria-label") ?? "";
      return /^All namespaces/.test(name)
        ? "all"
        : (name.match(/^ns-\d+/)?.[0] ?? "?");
    };
    const order = within(list).getAllByRole("option").map(label);

    // Row 0 is "All namespaces"; the two selected come next, then the rest in
    // the summary's own order.
    expect(order.slice(0, 3)).toEqual(["all", "ns-3", "ns-4"]);
    expect(order.slice(3)).toEqual(["ns-0", "ns-1", "ns-2", "ns-5"]);
  });

  /**
   * Lena aimed at "shop" and got "net": the rows moved between her looking
   * and her clicking. Fails if counts that change while the list is open, or
   * a namespace added to the selection, move any row under the pointer, or
   * if the next opening stops putting the selection first.
   */
  it("holds every row still while the list is open, and reorders at the next opening", async () => {
    const user = userEvent.setup();
    await draw(["ns-0"]);
    const list = await openPicker(user);
    const names = () =>
      within(list)
        .getAllByRole("option")
        .slice(1)
        .map((option) => option.getAttribute("aria-label")?.split(",")[0]);
    const before = names();
    expect(before.slice(0, 3)).toEqual(["ns-0", "ns-1", "ns-2"]);

    summary.namespaces = [...summary.namespaces].reverse();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Control>}");
    await user.click(rowFor("ns-4"));
    await user.keyboard("{/Control}");
    expect(scope()).toEqual(["ns-0", "ns-4"]);
    expect(names()).toEqual(before);

    await user.keyboard("{Escape}");
    const again = await openPicker(user);
    const reopened = within(again)
      .getAllByRole("option")
      .slice(1)
      .map((option) => option.getAttribute("aria-label")?.split(",")[0]);
    expect(reopened.slice(0, 3)).toEqual(["ns-4", "ns-0", "ns-5"]);
  });

  /**
   * #137: on a cluster split across teams the reader can see namespaces they
   * have no rights in. The picker stops offering the ones where nothing may
   * be listed, until asked to show them. Fails if such a namespace is
   * offered, if the footer does not say what is refused, or if the reveal
   * stops bringing it back.
   */
  it("hides the namespaces where nothing may be listed, with a way to show them", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [
      { namespace: "ns-2", allowed: false, otherLists: false },
    ];
    await draw([]);
    const list = await openPicker(user);

    // The refused one is gone; the others stay.
    await waitFor(() =>
      expect(within(list).queryByRole("option", { name: /^ns-2,/ })).toBeNull()
    );
    expect(
      within(list).getByRole("option", { name: /^ns-0,/ })
    ).toBeInTheDocument();

    // The footer says how many and what is refused, and offers to show them.
    expect(
      screen.getByText("1 namespace hidden: nothing in it may be listed")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show them/i }));
    expect(
      within(list).getByRole("option", { name: /^ns-2,/ })
    ).toHaveAccessibleName(/pod list forbidden/);
  });

  /**
   * Marco unchecked kube-system, where nothing may be listed, and its row
   * vanished under the pointer for a "1 namespace hidden" line. Fails if a
   * row drawn in this opening leaves it, or is not hidden at the next.
   */
  it("keeps a row it drew while the list is open, and hides it at the next opening", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [
      { namespace: "ns-2", allowed: false, otherLists: false },
    ];
    await draw(["ns-0", "ns-2"]);
    await openPicker(user);
    await waitFor(() =>
      expect(rowFor("ns-2")).toHaveAccessibleName(/pod list forbidden/)
    );

    await user.keyboard("{Control>}");
    await user.click(rowFor("ns-2"));
    await user.keyboard("{/Control}");
    expect(scope()).toEqual(["ns-0"]);
    expect(rowFor("ns-2")).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText(/hidden/)).toBeNull();

    await user.keyboard("{Escape}");
    await openPicker(user);
    expect(screen.queryByRole("option", { name: /^ns-2,/ })).toBeNull();
    expect(
      screen.getByText("1 namespace hidden: nothing in it may be listed")
    ).toBeInTheDocument();
  });

  /**
   * Marco's picker said "1 namespace hidden: no access" for team-blind, where
   * he may list Deployments, Services and Events and only pods are refused.
   * Fails if a namespace refusing pods and serving other lists, or one whose
   * other lists could not be asked about, is hidden or loses the words
   * saying it refuses pods.
   */
  it("offers a namespace that refuses only pods, saying so", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [
      { namespace: "ns-2", allowed: false, otherLists: true },
      { namespace: "ns-5", allowed: false, otherLists: null },
    ];
    await draw([]);
    const list = await openPicker(user);

    await waitFor(() =>
      expect(
        within(list).getByRole("option", { name: /^ns-2,/ })
      ).toHaveAccessibleName(/pod list forbidden/)
    );
    expect(
      within(list).getByRole("option", { name: /^ns-5,/ })
    ).toHaveAccessibleName(/pod list forbidden/);
    expect(screen.queryByText(/hidden/)).toBeNull();
  });

  /**
   * The third state the hide must never swallow: a namespace the authorizer
   * could not be asked about (null) is not a refusal, and stays offered.
   */
  it("keeps offering a namespace whose access could not be checked", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [{ namespace: "ns-2", allowed: null }];
    await draw([]);
    const list = await openPicker(user);

    expect(
      within(list).getByRole("option", { name: /^ns-2,/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show them/i })
    ).not.toBeInTheDocument();
  });

  /**
   * Both gestures without a mouse, on a list that is one tab stop. Would
   * break if the rows went back to being focusable controls: an option's
   * children are presentational, so a button in one is announced as nothing
   * and a sixty-namespace cluster becomes a hundred and twenty tab presses.
   */
  it("does the same two things from the keyboard alone", async () => {
    const user = userEvent.setup();
    await draw([]);
    const list = await openPicker(user);
    const filter = screen.getByRole("combobox", { name: "Filter namespaces" });

    expect(list.querySelector("button")).toBeNull();
    expect(filter).toHaveFocus();

    // Arrow onto a row: the caret stays put and the row is named instead.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(filter).toHaveAttribute("aria-activedescendant", rowFor("ns-0").id);

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(scope()).toEqual(["ns-0"]);
    expect(screen.getByRole("listbox", { name: "Namespaces" })).toBeVisible();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(scope()).toEqual(["ns-1"]);
  });

  /**
   * The one place the ceiling is visible before it bites. Without this the
   * box that has gone quiet is a control that stopped working, and a reader
   * has no way to find out that watching a fifth namespace is a thing this
   * window will not do.
   */
  it("says how many it will watch, and says so again when it refuses", async () => {
    const user = userEvent.setup();
    await draw(Array.from({ length: SCOPE_LIMIT }, (_, i) => `ns-${i}`));
    await openPicker(user);

    const ceiling = `${SCOPE_LIMIT} namespaces is the most one window reads at once.`;
    expect(screen.getByText(ceiling)).toBeInTheDocument();

    // The row that cannot be added is described by that sentence, so it is
    // spoken on arrival rather than only printed under the list.
    const spare = rowFor(`ns-${SCOPE_LIMIT}`);
    expect(
      document.getElementById(spare.getAttribute("aria-describedby") as string)
    ).toHaveTextContent(ceiling);

    await user.keyboard("{Control>}");
    await user.click(spare);
    await user.keyboard("{/Control}");

    expect(scope()).toHaveLength(SCOPE_LIMIT);
    expect(
      screen.getByText(
        `Cannot watch ns-${SCOPE_LIMIT} as well: ${SCOPE_LIMIT} namespaces is the most one window reads at once. Open it on its own instead.`
      )
    ).toBeInTheDocument();
  });

  /**
   * The ceiling is on *adding*. Would break if a full selection ever stopped
   * a reader from opening the namespace they came here for.
   */
  it("still opens a namespace on its own at the ceiling", async () => {
    const user = userEvent.setup();
    await draw(Array.from({ length: SCOPE_LIMIT }, (_, i) => `ns-${i}`));
    await openPicker(user);

    await user.click(rowFor(`ns-${SCOPE_LIMIT}`));

    expect(scope()).toEqual([`ns-${SCOPE_LIMIT}`]);
  });
});

describe("a cluster that has been renamed", () => {
  beforeEach(() => {
    useClusterIdentityStore.setState({
      marks: { "k3d-dev": { alias: "payments" } },
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "prod-eu" })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("wears the name it was given where the strip names a cluster", async () => {
    await mount();
    expect(within(tabs()[0]).getByText("payments")).toBeInTheDocument();
    expect(within(tabs()[0]).queryByText("k3d-dev")).not.toBeInTheDocument();
  });

  it("keeps the context name in the accessible name, beside the alias", async () => {
    // A reader who cannot see the strip still has to know which context is
    // about to be acted on; one who can needs the name they gave it.
    await mount();
    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "payments (k3d-dev) · all namespaces · Overview"
    );
  });
});

describe("a cluster the kubeconfig has lost", () => {
  beforeEach(() => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "old", missing: true })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("reads as a state beside the name, not as a suffix on it", async () => {
    await mount();
    const gone = tabs()[1];
    expect(within(gone).getByText("old")).toBeInTheDocument();
    expect(within(gone).getByText("missing")).toBeInTheDocument();
    expect(gone.textContent).not.toContain("(missing)");
  });

  it("says so with a shape as well, not colour alone", async () => {
    await mount();
    const dot = tabs()[1].querySelector("span.rounded-full");
    // A ring, and no cluster colour painted into it.
    expect(dot?.className).toContain("border-fg-fnt");
    expect(dot?.getAttribute("style")).toBeNull();
  });

  it("always names the cluster it lost, whatever else the strip drops", async () => {
    await mount();
    expect(screen.getByText("old")).toBeInTheDocument();
  });
});

describe("a tab with no cluster", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: null, isConnected: false });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", context: null })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("collapses to one segment, and it is a verb", async () => {
    await mount();
    const strip = tabs()[0];
    expect(within(strip).getByText("Choose a cluster")).toBeInTheDocument();
    // The scope that cannot exist yet, and the page with nothing on it.
    expect(strip.textContent).not.toContain("no cluster");
    expect(strip.textContent).not.toContain("all namespaces");
    expect(strip.textContent).not.toContain("Overview");
  });

  it("keeps its place, because it is where a cluster gets picked", async () => {
    await mount();
    expect(tabs()).toHaveLength(1);
  });

  it("offers no close on the only tab, which has nothing to fall back to", async () => {
    await mount();
    expect(screen.queryByLabelText("Close tab")).not.toBeInTheDocument();
  });

  /**
   * The address decides which cluster the window is in, and its route is
   * what connects. Fails if picking connects by itself again: a second
   * answer to the same question, racing the address.
   */
  it("goes to the picked cluster's address and leaves the connecting to it", async () => {
    useClusterStore.setState({
      contexts: [
        {
          name: "prod-eu",
          cluster: "prod-eu",
          user: "prod-eu",
          namespace: null,
          is_current: false,
          server: null,
          exec_command: null,
          auth: { kind: "unrecognised" },
        },
      ],
    });
    const router = await mount("/");
    vi.mocked(commands.connectCluster).mockClear();

    await userEvent.click(screen.getByText("Choose a cluster"));
    await userEvent.click(
      await screen.findByRole("option", { name: /prod-eu/ })
    );

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/prod-eu")
    );
    expect(commands.connectCluster).not.toHaveBeenCalled();
  });
});

/**
 * A list that ran out of time offers "Pick one namespace", and the picker it
 * means lives here. The two halves are a dispatch and a listener with a
 * string between them, and only the dispatch was tested: the list's own test
 * registers a listener of its own and would pass with nothing in the app
 * listening at all. Deleting the effect here left every test green.
 */
describe("the namespace picker a timed-out list asks for", () => {
  it("opens on the active tab when a list asks for it", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", href: "/c/k3d-dev/pods" })],
      activeId: "a",
      pendingHref: null,
    });
    await mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(SCOPE_PICKER_OPEN));
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("a token that may not list namespaces", () => {
  const scope = () => useClusterStore.getState().namespaceScope;

  beforeEach(() => {
    summary.namespaceList = "refused";
    summary.podCount = null;
    useClusterStore.setState({
      contexts: [
        { name: "k3d-dev", namespace: "team-checkout" },
      ] as unknown as ContextInfo[],
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
  });

  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(tabs()[0]).getByText("All namespaces"));
    return screen.getByRole("listbox", { name: "Namespaces" });
  };

  /**
   * Marco's blocker: his Role reads one namespace and lists none, so the
   * picker had nothing to offer and Enter did nothing. Fails if a typed name
   * stops becoming the scope when the list was refused.
   */
  it("lets a typed namespace become the scope when the list was refused", async () => {
    const user = userEvent.setup();
    await mount();
    await openPicker(user);

    await user.keyboard("payments-team{Enter}");

    expect(scope()).toEqual(["payments-team"]);
  });

  /**
   * "No namespaces visible" about a list nobody could read is the third
   * state drawn as the second. Fails if the refusal stops being said, or if
   * the empty-cluster sentence comes back in its place.
   */
  it("says the list was refused, not that there are none", async () => {
    const user = userEvent.setup();
    await mount();
    await openPicker(user);

    expect(
      screen.getByText(t("empty", "namespacesRefused"))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(t("empty", "noNamespacesVisible"))
    ).not.toBeInTheDocument();
  });

  /** Fails if the kubeconfig's own namespace stops being offered without a list. */
  it("offers the kubeconfig namespace and the recent ones", async () => {
    const user = userEvent.setup();
    useNamespaceRecencyStore.setState({
      recent: { "k3d-dev": ["team-shared"] },
    });
    await mount();
    const list = await openPicker(user);

    expect(
      within(list).getByRole("option", {
        name: "team-checkout, from kubeconfig",
      })
    ).toBeInTheDocument();
    await user.click(
      within(list).getByRole("option", { name: "team-shared, recent" })
    );
    expect(scope()).toEqual(["team-shared"]);
  });

  /**
   * Marco typed kube-system, added it, and unchecked it: the row went from
   * under the pointer. Fails if a namespace the reader added and took back
   * leaves the list while it is open.
   */
  it("keeps a typed namespace's row after it is unchecked again", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [
      { namespace: "kube-system", allowed: false, otherLists: false },
    ];
    await mount();
    const list = await openPicker(user);

    await user.keyboard("kube-system{Control>}{Enter}{/Control}");
    expect(scope()).toEqual(["kube-system"]);
    await user.clear(screen.getByRole("combobox"));
    await user.keyboard("{Control>}");
    await user.click(
      within(list).getByRole("option", { name: /^kube-system/ })
    );
    await user.keyboard("{/Control}");

    expect(scope()).toEqual([]);
    expect(
      within(list).getByRole("option", { name: /^kube-system/ })
    ).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText(/namespace hidden/)).toBeNull();
  });

  /**
   * Marco on team-checkout typed team-blind, a recent namespace where he may
   * list nothing: the row hid behind "1 namespace hidden", and
   * neither Enter nor Ctrl+Enter took it. Fails if a namespace typed in full
   * is hidden, loses the words saying what it refuses, or cannot be picked
   * from the keyboard.
   */
  it("offers a refused namespace typed in full, says so, and takes it on Enter", async () => {
    const user = userEvent.setup();
    nsAccess.answers = [
      { namespace: "team-blind", allowed: false, otherLists: false },
    ];
    useNamespaceRecencyStore.setState({
      recent: { "k3d-dev": ["team-blind"] },
    });
    useClusterStore.setState({
      contexts: [],
      namespaceScope: ["team-checkout"],
      currentNamespace: "team-checkout",
    });
    await mount();
    await user.click(within(tabs()[0]).getByText("team-checkout"));
    const list = screen.getByRole("listbox", { name: "Namespaces" });
    await waitFor(() =>
      expect(
        within(list).queryByRole("option", { name: /^team-blind/ })
      ).toBeNull()
    );

    await user.keyboard("team-blind");
    expect(
      within(list).getByRole("option", { name: /^team-blind/ })
    ).toHaveAccessibleName("team-blind, pod list forbidden");
    expect(screen.queryByText(/namespace hidden/)).toBeNull();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(scope()).toEqual(["team-checkout", "team-blind"]);
    await user.keyboard("{Enter}");
    expect(scope()).toEqual(["team-blind"]);
  });

  /** Fails if a name the API server would reject could become the scope. */
  it("refuses a name that cannot be a namespace, and says why", async () => {
    const user = userEvent.setup();
    await mount();
    await openPicker(user);

    await user.keyboard("Team_Checkout{Enter}");

    expect(scope()).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("Team_Checkout");
  });

  /**
   * Once in, the namespace the window is on has to stay visible and
   * leavable even though no list names it. Fails if the active scope drops
   * out of the picker.
   */
  it("keeps the namespace the window is on in the list", async () => {
    const user = userEvent.setup();
    useClusterStore.setState({
      contexts: [],
      namespaceScope: ["team-checkout"],
      currentNamespace: "team-checkout",
    });
    await mount();
    await user.click(within(tabs()[0]).getByText("team-checkout"));

    expect(
      screen.getByRole("option", { name: /^team-checkout/ })
    ).toHaveAttribute("aria-selected", "true");
  });
});

describe("the count beside a namespace", () => {
  const open = async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
    const user = userEvent.setup();
    await mount();
    await user.click(within(tabs()[0]).getByText("All namespaces"));
    return screen.getByRole("listbox", { name: "Namespaces" });
  };

  /**
   * Dana's picker said "shop 14 · 10 bad" beside 9 pods not ready: the
   * number is the namespace's Needs attention rows, Deployments and Jobs
   * included, and "bad" read it as pods. Fails if it is called anything but
   * the problems the Overview lists.
   */
  it("calls the namespace's problems problems, as Needs attention counts them", async () => {
    summary.namespaces = [
      {
        name: "shop",
        podCount: 14,
        problems: { total: 10, complete: true, worst: "err" },
      },
    ];
    const list = await open();

    expect(within(list).getByText("14 · 10 problems")).toHaveClass("text-err");
    expect(within(list).queryByText(/bad/)).toBeNull();
  });

  /**
   * A namespace whose only trouble is an autoscaler that cannot read its
   * metrics is amber on its Overview. Fails if the picker paints it red.
   */
  it("takes the tone of the namespace's worst problem", async () => {
    summary.namespaces = [
      {
        name: "shop",
        podCount: 14,
        problems: { total: 1, complete: true, worst: "warn" },
      },
    ];
    const list = await open();

    expect(within(list).getByText("14 · 1 problem")).toHaveClass("text-warn");
  });

  /**
   * A kind the cluster would not list leaves the count short. Fails if a
   * short count reads as the whole count, or a namespace nobody could
   * check reads as one with no problems.
   */
  it("says the count is a floor when a kind was not checked there", async () => {
    summary.namespaces = [
      {
        name: "shop",
        podCount: 14,
        problems: { total: 3, complete: false, worst: "err" },
      },
      {
        name: "team-checkout",
        podCount: 4,
        problems: { total: 0, complete: false, worst: null },
      },
    ];
    const list = await open();

    expect(within(list).getByText("14 · 3+ problems")).toBeInTheDocument();
    expect(
      within(list).getByRole("option", { name: /^shop,/ })
    ).toHaveAccessibleName("shop, 14 pods, 3+ problems, not all checked");
    expect(within(list).getByText("4 · not all checked")).toBeInTheDocument();
  });
});

describe("a picker open on one tab", () => {
  /**
   * Closing the picker hands the focus back to its tab, and the tab's
   * tooltip opened on that focus and stayed over the page (Dana, shot 36).
   * Fails if a picker closing leaves the tooltip open.
   */
  it("does not leave its tab's tooltip open as it closes", async () => {
    const user = userEvent.setup();
    useScopeTabStore.setState({
      tabs: [
        tab({
          id: "a",
          href: "/c/k3d-dev/pods",
          namespace: "shop",
          scope: ["shop"],
        }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    useClusterStore.setState({
      currentNamespace: "shop",
      namespaceScope: ["shop"],
    });
    await mount("/c/k3d-dev/pods");
    await user.click(within(tabs()[0]).getByText("shop"));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  /**
   * Dana clicked another tab with a namespace picker open, three times, and
   * nothing moved: the click opened the tab, then the picker, closing on
   * the same click, took the window back to its own tab. Fails if a tab left
   * with its picker open keeps the picker, or its closing activates the tab.
   */
  it("shuts when another tab is opened, without taking the window back", async () => {
    const user = userEvent.setup();
    useScopeTabStore.setState({
      tabs: [
        tab({
          id: "a",
          href: "/c/k3d-dev/pods",
          namespace: "shop",
          scope: ["shop"],
        }),
        tab({
          id: "b",
          href: "/c/k3d-dev/events",
          namespace: "lena",
          scope: ["lena"],
        }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    useClusterStore.setState({
      currentNamespace: "shop",
      namespaceScope: ["shop"],
    });
    await mount("/c/k3d-dev/pods");
    await user.click(within(tabs()[0]).getByText("shop"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The clicked tab's own handler runs first; the picker hears the click after.
    await act(() => useScopeTabStore.getState().activateTab("b"));
    await user.keyboard("{Escape}");

    expect(useScopeTabStore.getState().activeId).toBe("b");
    expect(tabs()[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the new tab button", () => {
  /**
   * Its menu hands the focus back as it closes, and the button's tooltip
   * opened on that focus and stayed. Fails if a pick leaves it open.
   */
  it("does not pin its tooltip after a pick from its menu", async () => {
    const user = userEvent.setup();
    useClusterStore.setState({
      contexts: [{ name: "k3d-dev" }] as unknown as ContextInfo[],
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", href: "/c/k3d-dev" })],
      activeId: "a",
      pendingHref: null,
    });
    await mount();
    const button = screen.getByRole("button", {
      name: "New tab. Menu key opens it on another cluster.",
    });
    await user.pointer({ keys: "[MouseRight]", target: button });
    await user.click(
      await screen.findByRole("menuitem", { name: /New tab here/ })
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
