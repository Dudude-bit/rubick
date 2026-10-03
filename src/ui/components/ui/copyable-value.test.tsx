import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton, CopyableValue } from "./copyable-value";

/**
 * `userEvent.setup()` installs its own clipboard stub, so ours has to go in
 * afterwards or it is silently replaced and every assertion watches a mock
 * nothing calls.
 */
function stubClipboard(writeText = vi.fn(async () => {})) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("CopyableValue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the value on a click", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<CopyableValue value="10.42.0.6" />);
    await user.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalledWith("10.42.0.6");
  });

  /**
   * A confirmation gone before it can be read says nothing, and one that
   * never leaves stands in for the mark the next copy needs. Fails if it
   * expires inside a second or is still there two and a half seconds on.
   *
   * `fireEvent` and no `findBy`: userEvent and `waitFor` both settle on a
   * zero-delay timer, which a fake clock never fires on its own.
   */
  it("confirms in place long enough to read, then goes back to resting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubClipboard();
    const { container } = render(<CopyableValue value="10.42.0.6" />);
    await act(async () => {
      fireEvent.click(container.firstElementChild as HTMLElement);
    });
    expect(screen.getByTestId("copyable-confirmed")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByTestId("copyable-confirmed")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByTestId("copyable-mark")).toBeInTheDocument();
  });

  // A row that navigates must not navigate because someone copied an address.
  it("does not let the click reach the row underneath", async () => {
    const rowClick = vi.fn();
    const user = userEvent.setup();
    stubClipboard();
    render(
      <div onClick={rowClick}>
        <CopyableValue value="10.42.0.6" />
      </div>
    );
    await user.click(screen.getByRole("button"));
    expect(rowClick).not.toHaveBeenCalled();
  });

  // Claiming a success that did not happen is worse than staying quiet.
  it("does not claim to have copied when the clipboard refuses", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn(async () => Promise.reject(new Error("denied"))));
    render(<CopyableValue value="10.42.0.6" />);
    await user.click(screen.getByRole("button"));
    expect(screen.queryByTestId("copyable-confirmed")).toBeNull();
  });

  it("is reachable and named without a mouse", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<CopyableValue value="10.42.0.6" label="Pod IP 10.42.0.6" />);
    await user.tab();
    expect(screen.getByRole("button")).toHaveFocus();
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Copy Pod IP 10.42.0.6"
    );
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith("10.42.0.6");
  });

  it("shows the value itself, not a placeholder", () => {
    render(<CopyableValue value="10.43.107.238" />);
    expect(screen.getByText("10.43.107.238")).toBeInTheDocument();
  });
});

describe("CopyButton", () => {
  /** The mark beside a name that is itself a link: it copies, and neither the row nor a double click sees it. */
  it("copies the name and keeps the row and a double click out of it", async () => {
    const rowClick = vi.fn();
    const rowDouble = vi.fn();
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(
      <div onClick={rowClick} onDoubleClick={rowDouble}>
        <CopyButton value="web-7f4" label="Copy name: web-7f4" />
      </div>
    );
    await user.dblClick(
      screen.getByRole("button", { name: "Copy name: web-7f4" })
    );
    expect(writeText).toHaveBeenCalledWith("web-7f4");
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowDouble).not.toHaveBeenCalled();
  });
});
