import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { currentConnection, noteRefusal, refusalOf } from "@/lib/refusals";

import { UnreadList } from "./UnreadList";

describe("a list nobody could read", () => {
  /**
   * Under a metrics banner on Pods the refusal sat ~80px below it: the page
   * column's gap, the banner's margin and this block's own top padding all
   * stacked. The column and the banner already space it, so it adds none.
   * Fails if a top padding comes back.
   */
  it("adds no space of its own above the words", () => {
    render(<UnreadList error={new Error("forbidden")} words="Refused" />);
    const block = screen.getByTestId("unread-list");
    expect(block.className).not.toMatch(/\bp[ty]-\d/);
    expect(block).toHaveClass("pb-8");
  });

  /**
   * Marco's refused Events and Nodes pages said "no permission" with no way
   * to ask again after his rights changed. Fails if a refusal is offered no
   * read again, or if the kept refusal answers the second read from cache.
   */
  it("offers a refused list the read again a failing one gets, asking the cluster afresh", async () => {
    const forbidden = new Error(
      'events is forbidden: User "marco" cannot list'
    );
    const read = 'listEvents ["kube-system"]';
    noteRefusal(read, forbidden, currentConnection());
    const retry = vi.fn();
    render(<UnreadList error={forbidden} words="Refused" onRetry={retry} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(refusalOf(read)).toBeUndefined();
  });

  /**
   * Refused and failing both offer the read again, so the words alone must
   * tell them apart. Fails if a refusal is drawn in the failure's red cross.
   */
  it("draws a refusal with a lock in amber and a failure with a cross in red", () => {
    const { unmount } = render(
      <UnreadList
        error={new Error("pods is forbidden: User cannot list")}
        words="Refused"
        onRetry={() => {}}
      />
    );
    const refused = screen.getByText("Refused");
    expect(refused).toHaveAttribute("data-read", "refused");
    expect(refused).toHaveClass("text-warn");
    unmount();

    render(
      <UnreadList
        error={new Error("connection refused")}
        words="Failed"
        onRetry={() => {}}
      />
    );
    const failed = screen.getByText("Failed");
    expect(failed).toHaveAttribute("data-read", "failed");
    expect(failed).toHaveClass("text-err");
  });
});
