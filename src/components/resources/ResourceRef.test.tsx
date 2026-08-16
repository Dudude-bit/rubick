import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ResourceRef, isRoutableKind } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SIZE } from "./ResourceName";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/** Where the click landed: the peek is a query parameter, not component state. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

const wrap = (ui: ReactNode) =>
  render(
    <MemoryRouter initialEntries={["/events"]}>
      {ui}
      <LocationProbe />
    </MemoryRouter>
  );

const location = () => screen.getByTestId("location").textContent;

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
          href: "/events",
          missing: false,
        },
      ],
      activeId: "ref-tab",
      pendingHref: null,
    });
  });

  describe("routing", () => {
    it("links a routable namespaced kind to its detail page", () => {
      wrap(
        <ResourceRef
          kind="Pod"
          name="log-demo-596964f7d6-54zt4"
          namespace="k8s-gui-test"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/pods/k8s-gui-test/log-demo-596964f7d6-54zt4"
      );
    });

    it("links a cluster-scoped kind with no namespace", () => {
      wrap(<ResourceRef kind="Node" name="agent-0" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/nodes/agent-0"
      );
    });

    it("accepts a plural spelling of the kind", () => {
      wrap(<ResourceRef kind="pods" name="a-1" namespace="ns" />);
      expect(screen.getByRole("link")).toHaveAttribute("href", "/pods/ns/a-1");
    });

    it("renders text, not a link, for a kind the router does not serve", () => {
      wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
        />
      );
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getByText(/traefik/)).toBeInTheDocument();
    });

    /**
     * The same kind, told which CRD defines it. That one fact is the whole
     * difference between an object nobody can open and one with a page and a
     * peek — and every vendor page holds it already.
     */
    it("links a custom resource once it is told its CRD", () => {
      wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
          crd="helmreleases.helm.toolkit.fluxcd.io"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/customresourcedefinitions/helmreleases.helm.toolkit.fluxcd.io/instances/kube-system/traefik"
      );
    });

    it("opens a custom resource in the peek, not on its own page", async () => {
      wrap(
        <ResourceRef
          kind="HelmRelease"
          name="traefik"
          namespace="kube-system"
          crd="helmreleases.helm.toolkit.fluxcd.io"
        />
      );
      await userEvent.click(screen.getByRole("link"));
      expect(location()).toBe(
        "/events?peek=helmreleases.helm.toolkit.fluxcd.io%2FHelmRelease%2Fkube-system%2Ftraefik"
      );
    });

    /** A cluster-scoped custom resource has no namespace to leave out. */
    it("links a cluster-scoped custom resource", () => {
      wrap(
        <ResourceRef
          kind="ClusterIssuer"
          name="letsencrypt"
          crd="clusterissuers.cert-manager.io"
        />
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/customresourcedefinitions/clusterissuers.cert-manager.io/instances/letsencrypt"
      );
    });

    it("renders text for a namespaced kind handed no namespace", () => {
      wrap(<ResourceRef kind="Pod" name="orphan" />);
      expect(screen.queryByRole("link")).toBeNull();
    });

    // The registry lists these; App.tsx serves them a list route only. Trusting
    // the registry alone is exactly how a dead link ships.
    it.each(["Namespace", "Event"])(
      "renders text for %s, which the router only lists",
      (kind) => {
        wrap(<ResourceRef kind={kind} name="kube-system" />);
        expect(screen.queryByRole("link")).toBeNull();
      }
    );

    it("agrees with isRoutableKind", () => {
      expect(isRoutableKind("Pod", "ns")).toBe(true);
      expect(isRoutableKind("Pod")).toBe(false);
      expect(isRoutableKind("Node")).toBe(true);
      expect(isRoutableKind("Namespace")).toBe(false);
      expect(isRoutableKind("Event", "ns")).toBe(false);
      expect(isRoutableKind("HelmRelease", "ns")).toBe(false);
    });
  });

  describe("text", () => {
    it("keeps the whole name readable as one string", () => {
      wrap(
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

    it("carries the kind as text for a screen reader even when shown as an icon", () => {
      wrap(
        <ResourceRef kind="Pod" name="a-1" namespace="ns" showKind={false} />
      );
      expect(screen.getByRole("link")).toHaveAccessibleName(/Pod/);
    });

    // The hued tail is a second span, and the accessible-name algorithm puts a
    // space between spans: "k3d-agent -0" is not the name of anything.
    it.each([true, false])(
      "announces exactly the kind and the real name (showKind=%s)",
      (showKind) => {
        wrap(
          <ResourceRef kind="Node" name="k3d-agent-0" showKind={showKind} />
        );
        expect(screen.getByRole("link")).toHaveAccessibleName(
          "Node k3d-agent-0"
        );
      }
    );

    // A ragged left edge is exactly what an icon column exists to prevent.
    it("reserves the mark's width for a kind the registry does not carry", () => {
      wrap(<ResourceRef kind="HelmRelease" name="traefik" namespace="ns" />);
      expect(screen.getByTestId("resource-ref-icon")).toBeInTheDocument();
    });

    it("still names the kind when it is not routable", () => {
      wrap(<ResourceRef kind="Pod" name="orphan" showKind={false} />);
      expect(screen.getByText("Pod", { exact: false })).toBeInTheDocument();
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

    it("full tints the kind icon and the generated tail with different hues", () => {
      renderRef();
      expect(styleOf("resource-ref-icon")).toContain("var(--kind-s)");
      expect(styleOf("resource-ref-kind")).toContain("var(--kind-s)");
      expect(styleOf("resource-ref-tail")).toContain("var(--ident-s)");
      // The stem repeats down a column; the tail is what tells rows apart.
      expect(screen.getByTestId("resource-ref-stem").className).toContain(
        "text-fg-mut"
      );
    });

    it("full tints an ungenerated name whole, since it is its own identity", () => {
      wrap(<ResourceRef kind="Pod" name="metrics-server" namespace="ns" />);
      expect(styleOf("resource-ref-stem")).toContain("hsl");
      expect(screen.getByTestId("resource-ref-stem").className).not.toContain(
        "text-fg-mut"
      );
    });

    it("minimal keeps the kind hue on the icon only and dims the tail", () => {
      colouring("minimal");
      renderRef();
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

    it("off drops every tint and leaves the whole name at full contrast", () => {
      colouring("off");
      renderRef();
      expect(screen.getByRole("link").innerHTML).not.toContain("hsl");
      for (const part of ["resource-ref-stem", "resource-ref-tail"]) {
        expect(screen.getByTestId(part).className).toContain("text-fg");
        expect(screen.getByTestId(part).className).not.toMatch(
          /text-fg-(mut|fnt)/
        );
      }
    });

    it("gives two kinds sharing a name different tail hues", () => {
      const { unmount } = wrap(
        <ResourceRef kind="Pod" name="cron-demo-29765945" namespace="ns" />
      );
      const pod = styleOf("resource-ref-tail");
      unmount();
      wrap(<ResourceRef kind="Job" name="cron-demo-29765945" namespace="ns" />);
      expect(styleOf("resource-ref-tail")).not.toBe(pod);
    });
  });

  describe("click", () => {
    const renderRef = (onClick?: () => void) =>
      wrap(
        <ResourceRef kind="Pod" name="a-1" namespace="ns" onClick={onClick} />
      );

    it("opens the peek instead of navigating, keeping the page underneath", async () => {
      renderRef();
      await userEvent.click(screen.getByRole("link"));
      expect(location()).toBe("/events?peek=pods%2Fns%2Fa-1");
    });

    // The webview has no second window, so the modified click that used to
    // fall through to the browser opens a scope tab — the same promise.
    it.each([
      ["ctrl", { ctrlKey: true }, true],
      ["meta", { metaKey: true }, true],
      ["shift", { shiftKey: true }, false],
    ])("opens a %s click in a new tab", (_label, init, background) => {
      renderRef();
      const link = screen.getByRole("link");
      fireEvent.click(link, init);
      const { tabs, activeId } = useScopeTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs[1].href).toBe("/pods/ns/a-1");
      expect(activeId === tabs[1].id).toBe(!background);
      // The page underneath is untouched either way.
      expect(location()).toBe("/events");
      expect(link).toHaveAttribute("href", "/pods/ns/a-1");
    });

    it("opens a middle click behind the page being read", () => {
      renderRef();
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
      expect(tabs[1].href).toBe("/pods/ns/a-1");
      expect(activeId).toBe("ref-tab");
      expect(location()).toBe("/events");
    });

    // Alt-click is the browser's save gesture, not a navigation.
    it("leaves an alt click to the browser", () => {
      renderRef();
      const handled = fireEvent.click(screen.getByRole("link"), {
        altKey: true,
      });
      expect(handled).toBe(true);
      expect(useScopeTabStore.getState().tabs).toHaveLength(1);
      expect(location()).toBe("/events");
    });

    it("hands a plain click to onClick without losing the href", async () => {
      const onClick = vi.fn();
      renderRef(onClick);
      await userEvent.click(screen.getByRole("link"));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("link")).toHaveAttribute("href", "/pods/ns/a-1");
    });

    it("lets onClick call off the peek entirely", () => {
      wrap(
        <ResourceRef
          kind="Pod"
          name="a-1"
          namespace="ns"
          onClick={(event) => event.preventDefault()}
        />
      );
      fireEvent.click(screen.getByRole("link"), { button: 0 });
      expect(location()).toBe("/events");
    });

    it("does not call onClick for an unroutable reference", async () => {
      const onClick = vi.fn();
      wrap(<ResourceRef kind="HelmRelease" name="traefik" onClick={onClick} />);
      await userEvent.click(screen.getByText(/traefik/));
      expect(onClick).not.toHaveBeenCalled();
    });
  });
});

// `ROUTABLE` restates what `App.tsx` serves, and a set that drifts from the
// router fails in the quietest possible way: the reference silently stops
// being a link. Read the routes back and hold the two together.
describe("ROUTABLE against the router", () => {
  it("lists exactly the kinds App.tsx serves a detail route", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const declared = new Set(
      [
        ...app.matchAll(
          /toPlural\(ResourceType\.(\w+)\)\}\/:(?:namespace\/)?:?name/g
        ),
      ].map((m) => m[1])
    );
    for (const kind of declared) {
      expect(
        isRoutableKind(kind, "some-namespace"),
        `${kind} has a detail route but ResourceRef renders it as text`
      ).toBe(true);
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

  it("tints the whole name of a node", () => {
    wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />);
    expect(styleOf("resource-ref-stem")).toContain("hsl");
    expect(screen.getByTestId("resource-ref-stem").className).not.toContain(
      "text-fg-mut"
    );
  });

  it("gives two nodes that differ only in their role distinct hues", () => {
    const { unmount } = wrap(
      <ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />
    );
    const agent = styleOf("resource-ref-stem");
    unmount();
    wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-server-0" />);
    expect(styleOf("resource-ref-stem")).not.toBe(agent);
  });

  it("tints the whole name when there is no tail at all", () => {
    wrap(<ResourceRef kind="Pod" name="bad-image-demo" namespace="ns" />);
    expect(styleOf("resource-ref-stem")).toContain("hsl");
  });

  it("still dims the stem when the tail is a real generated one", () => {
    wrap(
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

  it("leaves a node name uncoloured when colouring is off", () => {
    useDisplaySettingsStore.setState({ resourceColouring: "off" });
    wrap(<ResourceRef kind="Node" name="k3d-k8s-gui-dev-agent-0" />);
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

  it("sets its own size rather than inheriting the box it lands in", () => {
    render(
      <MemoryRouter>
        <div className="text-[32px]">
          <ResourceRef kind="Pod" name="crash-demo-c688f57cf" namespace="ns" />
        </div>
      </MemoryRouter>
    );
    expect(
      nameClass().split(/\s+/),
      "the name inherits its size — that is the bug this test exists for"
    ).toContain(RESOURCE_NAME_SIZE.row);
  });

  it("draws a title a step above a row, and both from the same scale", () => {
    const { unmount } = wrap(<ResourceName kind="Pod" name="crash-demo" />);
    const row = nameClass();
    unmount();
    wrap(<ResourceName kind="Pod" name="crash-demo" size="title" />);
    expect(row).toContain(RESOURCE_NAME_SIZE.row);
    expect(nameClass()).toContain(RESOURCE_NAME_SIZE.title);
    expect(nameClass()).not.toBe(row);
  });
});
