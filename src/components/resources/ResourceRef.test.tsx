import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ResourceRef, isRoutableKind } from "./ResourceRef";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";

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
  beforeEach(() => colouring("full"));

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
    it.each(["ReplicaSet", "HelmRelease"])(
      "reserves the mark's width for %s, which the registry does not carry",
      (kind) => {
        wrap(<ResourceRef kind={kind} name="traefik" namespace="ns" />);
        expect(screen.getByTestId("resource-ref-icon")).toBeInTheDocument();
      }
    );

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

    // A reference that cannot be opened in a new window is worse than the
    // plain link it replaced, so the browser keeps every modified click.
    it.each([
      ["ctrl", { ctrlKey: true }],
      ["meta", { metaKey: true }],
      ["shift", { shiftKey: true }],
      ["middle button", { button: 1 }],
    ])("leaves a %s click to the browser", (_label, init) => {
      renderRef();
      const link = screen.getByRole("link");
      const handled = fireEvent.click(link, init);
      expect(handled).toBe(true);
      expect(location()).toBe("/events");
      expect(link).toHaveAttribute("href", "/pods/ns/a-1");
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
