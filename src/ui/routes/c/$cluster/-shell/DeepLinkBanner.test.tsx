import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";

import { useClusterStore } from "@/stores/clusterStore";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { renderWithRouter } from "@/test/render";
import { DeepLinkBanner, LINK_NOTE_MS, LinkOpenedNote } from "./DeepLinkBanner";

const PATH = "/c/acme/deployments/lena-sandbox/hello-web";
const setNamespaceScope = vi.fn(async () => {});

describe("the note a live link leaves", () => {
  function arriveLive() {
    useClusterStore.setState({
      currentContext: "acme",
      isConnected: true,
      namespaceScope: [],
      setNamespaceScope,
    });
    useDeepLinkStore.setState({
      arrival: {
        status: "live",
        link: { context: "acme", path: PATH, capturedAt: null },
      },
    });
  }

  function renderNote() {
    return render(
      <TooltipProvider>
        <footer>
          <LinkOpenedNote />
        </footer>
      </TooltipProvider>
    );
  }

  afterEach(() => vi.useRealTimers());

  /** Floating bottom right, it covered the log viewer's "shown / Streaming" footer and toasts; fails if it leaves the status strip again. */
  it("sits in the status strip instead of floating over the page", () => {
    arriveLive();
    const { container } = renderNote();
    const note = screen.getByRole("status");
    expect(container.querySelector("footer")?.contains(note)).toBe(true);
    expect(note.className).not.toContain("fixed");
  });

  /** Lena had it on screen for ten minutes; fails if the timer is removed. */
  it("leaves on its own a few seconds after it appears", () => {
    vi.useFakeTimers();
    arriveLive();
    renderNote();
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS));
    expect(useDeepLinkStore.getState().arrival).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  /** A reader halfway through the sentence would lose it; fails if pointing at it no longer holds it. */
  it("stays while the pointer rests on it", () => {
    vi.useFakeTimers();
    arriveLive();
    renderNote();
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS * 3));
    expect(useDeepLinkStore.getState().arrival).not.toBeNull();
    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS));
    expect(useDeepLinkStore.getState().arrival).toBeNull();
  });

  /**
   * At the narrowest window Lena saw the note shrink to its icon, and at a
   * wide one Dana saw its whole sentence repeated above it. Fails if a cut
   * sentence offers nothing on hover, or a whole one offers itself again.
   */
  it.each([
    [400, 120, "the whole sentence"],
    [120, 120, "nothing"],
  ])(
    "offers %i px of text in a %i px box %s on hover",
    (scrollWidth, clientWidth) => {
      const scroll = vi
        .spyOn(HTMLElement.prototype, "scrollWidth", "get")
        .mockReturnValue(scrollWidth);
      const client = vi
        .spyOn(HTMLElement.prototype, "clientWidth", "get")
        .mockReturnValue(clientWidth);
      try {
        arriveLive();
        renderNote();
        const sentence = screen.getByText(
          "Opened from a link. You are looking at the cluster now."
        );
        expect(sentence.getAttribute("title")).toBe(
          scrollWidth > clientWidth ? sentence.textContent : null
        );
      } finally {
        scroll.mockRestore();
        client.mockRestore();
      }
    }
  );

  /** The page area must not draw a second copy over the page. */
  it("is not drawn by the page area", async () => {
    arriveLive();
    await renderWithRouter(<DeepLinkBanner />, {
      at: PATH,
      route: "/c/$cluster/deployments/$namespace/$name",
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
