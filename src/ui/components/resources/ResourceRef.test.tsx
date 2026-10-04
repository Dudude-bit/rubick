import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SIZE } from "./ResourceName";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
import { objectLink } from "@/lib/links";
import { RESOURCE_REGISTRY } from "@/lib/resource-registry";
import { renderWithRouter } from "@/test/render";

/** Where the click landed: the peek is a query parameter, not component state. */
function LocationProbe() {
  const { pathname, searchStr } = useLocation();
  return <span data-testid="location">{`${pathname}${searchStr}`}</span>;
}

const EVENTS = "/c/prod/events";

let router: AnyRouter;

const wrap = async (ui: ReactNode) => {
  const rendered = await renderWithRouter(
    <>
      {ui}
      <LocationProbe />
    </>,
    { at: EVENTS, route: "/c/$cluster/$" }
  );
  router = rendered.router;
  return rendered;
};

const location = () => screen.getByTestId("location").textContent;

const goesTo = (expected: string) =>
  vi.waitFor(() => expect(location()).toBe(expected));

/** Lets a navigation that was started finish, so "nothing happened" means it. */
const staysAt = async (expected = EVENTS) => {
  await act(() => router.load());
  expect(location()).toBe(expected);
};

const styleOf = (testId: string) =>
  screen.getByTestId(testId).getAttribute("style") ?? "";

const colouring = (value: ResourceColouring) =>
  useDisplaySettingsStore.setState({ resourceColouring: value });

describe("ResourceRef", () => {
  beforeEach(() => {
    colouring("full");
    useScopeTabStore.setState({
      tabs: [
        {
          id: "ref-tab",
          context: null,
          namespace: "",
          href: EVENTS,
          missing: false,
        },
      ],
      activeId: "ref-tab",
      pendingHref: null,
    });
  });

  /**
   * Issue #178: a right-click reached the webview's own menu, whose "Copy
   * link address" copied `http://tauri.localhost/...`. The link opens the
   * app's menu instead.
   *
   * The `preventDefault` is asserted and not assumed: it is the whole of
   * what stops the webview menu, and filling the store while letting the
   * event through would leave the reader with the menu they complained
   * about. Without that assertion this test passed with the line deleted.
   */
  it("opens the object menu on a right-click, at the pointer, and claims the event", async () => {
    await wrap(<ResourceRef kind="Pod" name="web" namespace="shop" />);
    const claimed = fireEvent.contextMenu(
      screen.getByRole("link", { name: "Pod web" }),
      { clientX: 40, clientY: 60 }
    );
    // `fireEvent` returns false when a handler called `preventDefault`.
    expect(claimed).toBe(false);
    expect(useObjectMenuStore.getState().target).toEqual({
      name: "web",
      to: "/c/prod/pods/shop/web",
      x: 40,
      y: 60,
    });
  });

  describe("routing", () => {
    it("links a routable namespaced kind to its detail page", async () => {
      await wrap(
        <ResourceRef
          kind="Pod"
          name="log-demo-596964f7d6-54zt4"
          namespace="k8s-gui-test"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/pods/k8s-gui-test/log-demo-596964f7d6-54zt4"
      );
    });

    it("links a cluster-scoped kind with no namespace", async () => {
      await wrap(<ResourceRef kind="Node" name="agent-0" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/nodes/agent-0"
      );
    });

    it("accepts a plural spelling of the kind", async () => {
      await wrap(<ResourceRef kind="pods" name="a-1" namespace="ns" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/pods/ns/a-1"
      );
    });

    it("renders text, not a link, for a kind the router does not serve", async () => {
      await wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
        />
      );
      expect(screen.queryByRole("link")).toBeNull();
      // The drawn name, not the hidden one the reader is given.
      expect(screen.getByTestId("resource-ref-name")).toHaveTextContent(
        "traefik"
      );
    });

    /**
     * The same kind, told which CRD defines it. That one fact is the whole
     * difference between an object nobody can open and one with a page and a
     * peek — and every vendor page holds it already.
     */
    it("links a custom resource once it is told its CRD", async () => {
      await wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
          crd="helmreleases.helm.toolkit.fluxcd.io"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/helmreleases.helm.toolkit.fluxcd.io/kube-system/traefik"
      );
    });

    it("opens a custom resource in the peek, not on its own page", async () => {
      await wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
          crd="helmreleases.helm.toolkit.fluxcd.io"
        />
      );
      await userEvent.click(screen.getByRole("link"));
      await goesTo(
        "/c/prod/events?peek=helmreleases.helm.toolkit.fluxcd.io%2FHelmRelease%2Fkube-system%2Ftraefik"
      );
    });

    /** A cluster-scoped custom resource has no namespace to leave out. */
    it("links a cluster-scoped custom resource", async () => {
      await wrap(
        <ResourceRef
          kind="ClusterIssuer"
          name="letsencrypt"
          crd="clusterissuers.cert-manager.io"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/clusterissuers.cert-manager.io/letsencrypt"
      );
    });

    it("renders text for a namespaced kind handed no namespace", async () => {
      await wrap(<ResourceRef kind="Pod" name="orphan" />);
      expect(screen.queryByRole("link")).toBeNull();
    });

    // An Event has no page of its own, so it opens the generic one every
    // registry kind falls back to.
    it("links an Event to the generic page", async () => {
      await wrap(<ResourceRef kind="Event" name="web.17a2" namespace="shop" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/events/shop/web.17a2"
      );
    });

    it("links a Namespace to its own page", async () => {
      await wrap(<ResourceRef kind="Namespace" name="kube-system" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/namespaces/kube-system"
      );
    });

    it("agrees with objectLink", () => {
      const links = (kind: string, namespace?: string) =>
        objectLink({ kind, name: "x", namespace }) !== null;
      expect(links("Pod", "ns")).toBe(true);
      expect(links("Pod")).toBe(false);
      expect(links("Node")).toBe(true);
      expect(links("Namespace")).toBe(true);
      expect(links("Event", "ns")).toBe(true);
      expect(links("HelmRelease", "ns")).toBe(false);
    });
  });

  describe("text", () => {
    it("keeps the whole name readable as one string", async () => {
      await wrap(
        <ResourceRef
          kind="Pod"
          name="cron-demo-29765945-cl6m2"
          namespace="ns"
        />
      );
      expect(screen.getByRole("link")).toHaveTextContent(
        "cron-demo-29765945-cl6m2"
      );
    });

    it("carries the kind as text for a screen reader even when shown as an icon", async () => {
      await wrap(
        <ResourceRef kind="Pod" name="a-1" namespace="ns" showKind={false} />
      );
      expect(screen.getByRole("link")).toHaveAccessibleName(/Pod/);
    });

    // The hued tail is a second span, and the accessible-name algorithm puts a
    // space between spans: "k3d-agent -0" is not the name of anything.
    it.each([true, false])(
      "announces exactly the kind and the real name (showKind=%s)",
      async (showKind) => {
        await wrap(
          <ResourceRef kind="Node" name="k3d-agent-0" showKind={showKind} />
        );
        expect(screen.getByRole("link")).toHaveAccessibleName(
          "Node k3d-agent-0"
        );
      }
    );

    // The same for the half that is not a link. A bare span is role=generic,
    // where ARIA prohibits naming — an `aria-label` there is dropped and the
    // two spans are announced joined, "k3d-agent -0" again. The name has to
    // be real text a reader can be given.
    it.each([true, false])(
      "announces the kind and the real name when it is not a link (showKind=%s)",
      async (showKind) => {
        await wrap(
          <ResourceRef kind="Pod" name="k3d-agent-0" showKind={showKind} />
        );
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getByText("Pod k3d-agent-0")).toBeInTheDocument();
      }
    );

    // A ragged left edge is exactly what an icon column exists to prevent.
    it("reserves the mark's width for a kind the registry does not carry", async () => {
      await wrap(
        <ResourceRef kind="HelmRelease" name="traefik" namespace="ns" />
      );
      expect(screen.getByTestId("resource-ref-icon")).toBeInTheDocument();
    });

    it("still names the kind when it is not routable", async () => {
      await wrap(<ResourceRef kind="Pod" name="orphan" showKind={false} />);
      expect(screen.getByText("Pod orphan")).toBeInTheDocument();
    });
  });

  describe("colouring", () => {
    const renderRef = () =>
      wrap(
        <ResourceRef
          kind="Pod"
          name="cron-demo-29765945-cl6m2"
          namespace="ns"
        />
      );

    it("full tints the kind icon and the generated tail with different hues", async () => {
      await renderRef();
      expect(styleOf("resource-ref-icon")).toContain("var(--kind-s)");
      expect(styleOf("resource-ref-kind")).toContain("var(--kind-s)");
      expect(styleOf("resource-ref-tail")).toContain("var(--ident-s)");
      // The stem repeats down a column; the tail is what tells rows apart.
      expect(screen.getByTestId("resource-ref-stem").className).toContain(
        "text-fg-mut"
      );
    });

    it("full tints an ungenerated name whole, since it is its own identity", async () => {
      await wrap(
        <ResourceRef kind="Pod" name="metrics-server" namespace="ns" />
      );
      expect(styleOf("resource-ref-stem")).toContain("hsl");
      expect(screen.getByTestId("resource-ref-stem").className).not.toContain(
        "text-fg-mut"
      );
    });

    it("minimal keeps the kind hue on the icon only and dims the tail", async () => {
      colouring("minimal");
      await renderRef();
      expect(styleOf("resource-ref-icon")).toContain("var(--kind-s)");
      expect(styleOf("resource-ref-kind")).not.toContain("hsl");
      expect(styleOf("resource-ref-tail")).not.toContain("hsl");
      expect(screen.getByTestId("resource-ref-tail").className).toContain(
        "text-fg-fnt"
      );
      expect(screen.getByTestId("resource-ref-stem").className).not.toContain(
        "text-fg-mut"
      );
    });

    it("off drops every tint and leaves the whole name at full contrast", async () => {
      colouring("off");
      await renderRef();
      expect(screen.getByRole("link").innerHTML).not.toContain("hsl");
      for (const part of ["resource-ref-stem", "resource-ref-tail"]) {
        expect(screen.getByTestId(part).className).toContain("text-fg");
        expect(screen.getByTestId(part).className).not.toMatch(
          /text-fg-(mut|fnt)/
        );
      }
    });

    it("gives two kinds sharing a name different tail hues", async () => {
      const { unmount } = await wrap(
        <ResourceRef kind="Pod" name="cron-demo-29765945" namespace="ns" />
      );
      const pod = styleOf("resource-ref-tail");
      unmount();
      await wrap(
        <ResourceRef kind="Job" name="cron-demo-29765945" namespace="ns" />
      );
      expect(styleOf("resource-ref-tail")).not.toBe(pod);
    });
  });

  describe("click", () => {
    const renderRef = (onClick?: () => void) =>
      wrap(
        <ResourceRef kind="Pod" name="a-1" namespace="ns" onClick={onClick} />
      );

    it("opens the peek instead of navigating, keeping the page underneath", async () => {
      await renderRef();
      await userEvent.click(screen.getByRole("link"));
      await goesTo("/c/prod/events?peek=pods%2Fns%2Fa-1");
    });

    // The webview has no second window, so the modified click that used to
    // fall through to the browser opens a scope tab — the same promise.
    it.each([
      ["ctrl", { ctrlKey: true }, true],
      ["meta", { metaKey: true }, true],
      ["shift", { shiftKey: true }, false],
    ])("opens a %s click in a new tab", async (_label, init, background) => {
      await renderRef();
      const link = screen.getByRole("link");
      fireEvent.click(link, init);
      const { tabs, activeId } = useScopeTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs[1].href).toBe("/c/prod/pods/ns/a-1");
      expect(activeId === tabs[1].id).toBe(!background);
      // The page underneath is untouched either way.
      await staysAt();
      expect(link).toHaveAttribute("href", "/c/prod/pods/ns/a-1");
    });

    it("opens a middle click behind the page being read", async () => {
      await renderRef();
      // Testing Library has no `auxClick` helper; React binds `onAuxClick`
      // to the native `auxclick` event, so dispatch that one.
      fireEvent(
        screen.getByRole("link"),
        new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 1,
        })
      );
      const { tabs, activeId } = useScopeTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs[1].href).toBe("/c/prod/pods/ns/a-1");
      expect(activeId).toBe("ref-tab");
      await staysAt();
    });

    // Alt-click is the browser's save gesture, not a navigation.
    it("leaves an alt click to the browser", async () => {
      await renderRef();
      const handled = fireEvent.click(screen.getByRole("link"), {
        altKey: true,
      });
      expect(handled).toBe(true);
      expect(useScopeTabStore.getState().tabs).toHaveLength(1);
      await staysAt();
    });

    it("hands a plain click to onClick without losing the href", async () => {
      const onClick = vi.fn();
      await renderRef(onClick);
      await userEvent.click(screen.getByRole("link"));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/c/prod/pods/ns/a-1"
      );
    });

    it("lets onClick call off the peek entirely", async () => {
      await wrap(
        <ResourceRef
          kind="Pod"
          name="a-1"
          namespace="ns"
          onClick={(event) => event.preventDefault()}
        />
      );
      fireEvent.click(screen.getByRole("link"), { button: 0 });
      await staysAt();
    });

    it("does not call onClick for an unroutable reference", async () => {
      const onClick = vi.fn();
      await wrap(
        <ResourceRef kind="HelmRelease" name="traefik" onClick={onClick} />
      );
      await userEvent.click(screen.getByTestId("resource-ref-name"));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  /**
   * Where two objects wear one name, the namespace is the identity — and it
   * belongs inside the reference, truncating and hover-highlighting with the
   * name, not printed beside it as a loose prefix that wraps on its own.
   */
  describe("showNamespace", () => {
    it("draws the namespace inside the reference, dim and mono", async () => {
      await wrap(
        <ResourceRef kind="Pod" name="a-1" namespace="backend" showNamespace />
      );
      const prefix = screen.getByTestId("resource-ref-namespace");
      expect(prefix).toHaveTextContent("backend/");
      // Inside the link, so the whole thing is one hover target.
      expect(screen.getByRole("link", { name: "Pod a-1" })).toContainElement(
        prefix
      );
    });

    it("prints nothing extra unasked", async () => {
      await wrap(<ResourceRef kind="Pod" name="a-1" namespace="backend" />);
      expect(screen.queryByTestId("resource-ref-namespace")).toBeNull();
    });
  });
});

// A kind the registry knows that no link reaches is a reference that quietly
// turns into text. The router serves every one of them through the generic
// page, so the registry is the whole list.
describe("the registry against the router", () => {
  it("links every kind the registry knows", () => {
    for (const { kind } of RESOURCE_REGISTRY) {
      expect(
        objectLink({ kind, name: "x", namespace: "some-namespace" }),
        `${kind} is in the registry but ResourceRef renders it as text`
      ).not.toBeNull();
    }
  });
});

// A node is `k3d-k8s-gui-dev-agent-0`: siblings share everything but the last
// few characters, and the splitter's tail is the ordinal `-0`. Tinting two
// characters of a thirty-character string tells nobody anything.
describe("names whose tail is too thin to carry identity", () => {
  beforeEach(() => {
    useDisplaySettingsStore.setState({ resourceColouring: "full" });
  });

  const styleOf = (id: string) =>
    screen.getByTestId(id).getAttribute("style") ?? "";

  it("tints the whole name of a node", async () => {
    await wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />);
    expect(styleOf("resource-ref-stem")).toContain("hsl");
    expect(screen.getByTestId("resource-ref-stem").className).not.toContain(
      "text-fg-mut"
    );
  });

  it("gives two nodes that differ only in their role distinct hues", async () => {
    const { unmount } = await wrap(
      <ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />
    );
    const agent = styleOf("resource-ref-stem");
    unmount();
    await wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-server-0" />);
    expect(styleOf("resource-ref-stem")).not.toBe(agent);
  });

  it("tints the whole name when there is no tail at all", async () => {
    await wrap(<ResourceRef kind="Pod" name="bad-image-demo" namespace="ns" />);
    expect(styleOf("resource-ref-stem")).toContain("hsl");
  });

  it("still dims the stem when the tail is a real generated one", async () => {
    await wrap(
      <ResourceRef
        kind="Pod"
        name="crash-demo-56588f6b8c-8bj9v"
        namespace="ns"
      />
    );
    expect(styleOf("resource-ref-stem")).not.toContain("hsl");
    expect(screen.getByTestId("resource-ref-stem").className).toContain(
      "text-fg-mut"
    );
    expect(styleOf("resource-ref-tail")).toContain("hsl");
  });

  it("leaves a node name uncoloured when colouring is off", async () => {
    useDisplaySettingsStore.setState({ resourceColouring: "off" });
    await wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />);
    expect(styleOf("resource-ref-stem")).not.toContain("hsl");
    expect(styleOf("resource-ref-tail")).not.toContain("hsl");
  });
});

// The bug this guards: `ResourceName` set no font-size, so the name took
// whichever one an ancestor happened to specify — 16px in a Connections row,
// 12px in a table cell, 10px under a route. Five sizes for one component. A
// reference must carry its own size, and there must be exactly two to pick.
describe("size", () => {
  const nameClass = () => screen.getByTestId("resource-ref-name").className;

  it("offers only sizes that name a real font-size class", () => {
    const sizes = Object.entries(RESOURCE_NAME_SIZE);
    expect(sizes.length).toBeGreaterThan(0);
    for (const [size, className] of sizes) {
      expect(className, `size "${size}" names no font-size`).toMatch(
        /^text-(xs|sm|base|\[\d+(\.\d+)?px\])$/
      );
    }
  });

  it("sets its own size rather than inheriting the box it lands in", async () => {
    await wrap(
      <div className="text-[32px]">
        <ResourceRef kind="Pod" name="crash-demo-c688f57cf" namespace="ns" />
      </div>
    );
    expect(
      nameClass().split(/\s+/),
      "the name inherits its size — that is the bug this test exists for"
    ).toContain(RESOURCE_NAME_SIZE.row);
  });

  it("draws a title a step above a row, and both from the same scale", async () => {
    const { unmount } = await wrap(
      <ResourceName kind="Pod" name="crash-demo" />
    );
    const row = nameClass();
    unmount();
    await wrap(<ResourceName kind="Pod" name="crash-demo" size="title" />);
    expect(row).toContain(RESOURCE_NAME_SIZE.row);
    expect(nameClass()).toContain(RESOURCE_NAME_SIZE.title);
    expect(nameClass()).not.toBe(row);
  });
});
