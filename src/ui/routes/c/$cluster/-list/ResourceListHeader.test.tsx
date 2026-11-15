import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));
vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => ({ data: { version: "4.21.2" } }),
}));

import { ScreenShareProvider } from "@/components/share/screen-share";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import { ResourceListHeader } from "./ResourceListHeader";

beforeEach(() => {
  useClusterStore.setState({ isConnected: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  useLocaleStore.setState({ choice: null });
});

describe("ResourceListHeader", () => {
  /**
   * The freshness reading keeps room for its longest wording and sits at the
   * right of that room, so Share placed before it floated mid-row at 1024
   * while the Overview's sat at the edge. Fails if anything follows the
   * actions in the row.
   */
  it("ends the row with the actions, after the freshness reading", () => {
    render(
      <TooltipProvider>
        <ResourceListHeader
          title="Pods"
          count={13}
          dataUpdatedAt={Date.now()}
          live
          actions={<button type="button">Share</button>}
        />
      </TooltipProvider>
    );
    const share = screen.getByRole("button", { name: "Share" });
    const live = screen.getByText("live");
    expect(share.parentElement?.lastElementChild).toBe(share);
    expect(
      live.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe("the list header beside a peek", () => {
  /** The row's width, and what its controls take with their words, as Lena's Russian Pods drew them at 1024. */
  const mountAt = async (rowWidth: number) => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(rowWidth);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.tagName === "H2") return 30;
        if (this.dataset.testid === "section-count") return 15;
        return this.classList.contains("ml-auto") ? 419 : 0;
      }
    );
    useLocaleStore.setState({ choice: "ru" });
    const rendered = await renderWithRouter(
      <ScreenShareProvider>
        <TooltipProvider>
          <ResourceListHeader
            title="Pods"
            count={89}
            dataUpdatedAt={Date.now()}
            live
            actions={
              <ShareScreenAction screen={{ title: "Pods", scope: null }} />
            }
          />
        </TooltipProvider>
      </ScreenShareProvider>,
      { at: "/c/prod/pods" }
    );
    const share = screen.getByRole("button", { name: /Поделиться/ });
    const row = share.closest("[class*='items-baseline']") as HTMLElement;
    return { ...rendered, share, row };
  };

  /**
   * Beside a peek at 1024 in Russian, "онлайн" and "Поделиться" wrapped onto
   * two more lines and every row of the list dropped 43 px. Fails if the row
   * can wrap, or keeps the words where they do not fit.
   */
  it("draws Share and the freshness mark without their words, on one line, where the words do not fit", async () => {
    const { share, row, container } = await mountAt(304);
    expect(row).toHaveClass("flex-nowrap");
    expect(share).not.toHaveTextContent("Поделиться");
    expect(screen.getByText("онлайн")).toHaveClass("sr-only");
    expect(container.querySelectorAll("[data-text]")).toHaveLength(0);
  });

  /** Fails if the words go where the row has room for them. */
  it("keeps the words where the row has room for them", async () => {
    const { share } = await mountAt(784);
    expect(share).toHaveTextContent("Поделиться");
    expect(screen.getByText("онлайн")).not.toHaveClass("sr-only");
  });
});

describe("ResourceListHeader held notice", () => {
  /** Fails if a table whose notices are held back says nothing, or says it when nothing is held. */
  it("says a notice is waiting only while one is held", () => {
    const header = (held: boolean) => (
      <TooltipProvider>
        <ResourceListHeader title="Pods" count={13} live held={held} />
      </TooltipProvider>
    );
    const { rerender } = render(header(false));
    expect(screen.queryByTestId("list-held")).toBeNull();
    rerender(header(true));
    expect(screen.getByTestId("list-held")).toHaveTextContent(
      "shown when the pointer leaves the table"
    );
  });

  /** Fails if the held line is drawn in the info blue the links use instead of quiet text. */
  it("draws the waiting line as quiet text, not as a link", () => {
    render(
      <TooltipProvider>
        <ResourceListHeader title="Pods" count={13} live held />
      </TooltipProvider>
    );
    const line = screen.getByTestId("list-held");
    expect(line).toHaveClass("text-fg-mut");
    expect(line).not.toHaveClass("text-info");
  });
});
