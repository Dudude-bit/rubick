import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { DataFreshness } from "./data-freshness";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";

const wrap = (ui: React.ReactNode) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const UPDATED = Date.now();

beforeEach(() => {
  useClusterStore.setState({ isConnected: true });
  useLocaleStore.setState({ choice: null });
});

describe("what the freshness reading claims", () => {
  it("says nothing until data has arrived", () => {
    const { container } = wrap(<DataFreshness live />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Fails if a read that failed before anything arrived says nothing in the header. */
  it("says the read is failing, with no age, when nothing was ever read", () => {
    wrap(<DataFreshness stale />);
    expect(screen.getByText("read failing")).toBeInTheDocument();
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("only says live when a watch is actually feeding the view", () => {
    wrap(<DataFreshness dataUpdatedAt={UPDATED} live />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("says polling on a view that only re-reads on a timer", () => {
    wrap(<DataFreshness dataUpdatedAt={UPDATED} />);
    expect(screen.getByText("polling")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  it("never says live while disconnected, watch or no watch", () => {
    useClusterStore.setState({ isConnected: false });
    const { rerender } = wrap(<DataFreshness dataUpdatedAt={UPDATED} live />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <DataFreshness dataUpdatedAt={UPDATED} />
      </TooltipProvider>
    );
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  /**
   * Lena read "замедлено · 0 с" beside a page title and could not tell what
   * was slowed or what the bare age meant. Fails if the face goes back to a
   * word without its subject or an age without "назад".
   */
  it("says in Russian what is slowed and how long ago it read", () => {
    useLocaleStore.setState({ choice: "ru" });
    wrap(<DataFreshness dataUpdatedAt={Date.now() - 5000} slowed />);
    expect(screen.getByText("опрос реже обычного")).toBeInTheDocument();
    expect(screen.getByText(/^\d+\s*с назад$/)).toBeInTheDocument();
  });

  it("distinguishes the three states without relying on colour", () => {
    const dot = () =>
      document.querySelector("span.rounded-full")?.className ?? "";

    const polled = (
      <TooltipProvider>
        <DataFreshness dataUpdatedAt={UPDATED} />
      </TooltipProvider>
    );
    const { rerender, unmount } = wrap(
      <DataFreshness dataUpdatedAt={UPDATED} live />
    );
    expect(dot()).toContain("bg-ok");

    rerender(polled);
    expect(dot()).toContain("bg-fg-fnt");

    useClusterStore.setState({ isConnected: false });
    rerender(polled);
    // A ring rather than a fill: the shape carries it too.
    expect(dot()).toContain("border-fg-fnt");
    unmount();
  });
});

describe("a refused read", () => {
  /**
   * Marco pressed Try the read again on the refused Namespaces list and the
   * header said "polled less often · 2m ago": the age of the answer before
   * the grant was revoked, on a list nothing polls. Fails if a refusal reads
   * as polled or slowed, or carries the last answer's age instead of its own.
   */
  it("says refused, as old as the refusal, whatever the last answer was", () => {
    wrap(
      <DataFreshness
        dataUpdatedAt={Date.now() - 120_000}
        slowed
        refusedAt={Date.now() - 4000}
      />
    );
    expect(screen.getByText("refused")).toBeInTheDocument();
    expect(screen.getByText(/^\d+s ago$/)).toBeInTheDocument();
    expect(screen.queryByText("2m ago")).not.toBeInTheDocument();
    expect(screen.queryByText("polled less often")).not.toBeInTheDocument();
  });

  /** Fails if a list refused on its first read says nothing in the header. */
  it("says refused, with no age, when neither the refusal's time nor an answer is known", () => {
    wrap(<DataFreshness refusedAt={null} />);
    expect(screen.getByText("refused")).toBeInTheDocument();
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  /** Disconnected, nothing is refused or read: fails if refused outranks offline. */
  it("says offline over a refusal when the window is not connected", () => {
    useClusterStore.setState({ isConnected: false });
    wrap(<DataFreshness dataUpdatedAt={UPDATED} refusedAt={UPDATED} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("refused")).not.toBeInTheDocument();
  });
});

describe("the room the reading takes", () => {
  /**
   * The Events toolbar is right-aligned, so the label growing from "polling"
   * to "polled less often · 3s ago" pushed every control left of it by about
   * 100px each time the poll backed off, and clicks aimed at Warnings landed
   * on the limit menu. Fails if the box sizes to the current word alone.
   */
  it("keeps the width of its widest reading whatever it says now", () => {
    const { container } = wrap(<DataFreshness dataUpdatedAt={UPDATED} />);
    const reserved = [
      ...container.querySelectorAll<HTMLElement>("[data-text]"),
    ].map((ghost) => ghost.dataset.text);

    expect(screen.getByText("polling")).toBeInTheDocument();
    expect(reserved).toEqual(
      expect.arrayContaining(["polled less often", "offline", "59m ago"])
    );
    expect(container.textContent).not.toContain("polled less often");
  });
});
