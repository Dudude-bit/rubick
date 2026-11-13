import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { Button } from "./button";
import { ConfirmDialog } from "./confirm-dialog";
import { DangerousConfirmDialog } from "./dangerous-confirm-dialog";
import { SegmentedControl } from "./states";

vi.mock("@/hooks/useCritical", () => ({
  useCritical: () => ({ critical: false, context: null }),
}));

vi.mock("@/hooks/useCriticalGate", () => ({
  useCriticalGate: () => ({ notice: null, input: null, blocked: false }),
}));

describe("a button whose action is running", () => {
  /** Fails if a pending button can be pressed again, which sent two deletes. */
  it("takes no second press and says it is busy", () => {
    const press = vi.fn();
    render(
      <Button pending onClick={press}>
        <Trash2 data-testid="icon" />
        Delete
      </Button>
    );
    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    expect(press).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-spinner]")).not.toBeNull();
  });
});

describe("a confirmation whose action takes time", () => {
  const dialog = (
    onConfirm: () => unknown,
    onOpenChange: (open: boolean) => void
  ) => (
    <ConfirmDialog
      open
      title="Restart deployment"
      confirmLabel="Restart"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );

  /** Fails if the dialog closes on the click, so the pending state and the failure are never seen in it. */
  it("stays open and pending until the action succeeds", async () => {
    let finish: () => void = () => undefined;
    const run = new Promise<void>((resolve) => (finish = resolve));
    const openChange = vi.fn();
    render(dialog(() => run, openChange));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled()
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(openChange).not.toHaveBeenCalledWith(false);
    finish();
    await waitFor(() => expect(openChange).toHaveBeenCalledWith(false));
  });

  /** Fails if a failed action closes the dialog, leaving only a toast to say what happened. */
  it("stays open when the action fails", async () => {
    const openChange = vi.fn();
    render(dialog(() => Promise.reject(new Error("refused")), openChange));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled()
    );
    expect(openChange).not.toHaveBeenCalledWith(false);
  });

  /** Fails if a plain handler no longer closes the dialog the way it always did. */
  it("closes at once for an action that returns nothing", async () => {
    const openChange = vi.fn();
    render(dialog(() => undefined, openChange));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(openChange).toHaveBeenCalledWith(false));
  });
});

describe("a segmented control", () => {
  const segments = [
    { value: "list", label: "List" },
    { value: "stories", label: "Stories" },
  ] as const;

  /** Fails if the chosen segment is not announced as pressed. */
  it("marks the chosen segment pressed and switches on a press", () => {
    const change = vi.fn();
    render(
      <SegmentedControl
        label="View"
        value="list"
        segments={segments}
        onChange={change}
      />
    );
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Stories" }));
    expect(change).toHaveBeenCalledWith("stories");
  });

  /** Fails if pressing the chosen segment again clears a choice that has no empty state. */
  it("clears only where clearing means something", () => {
    const change = vi.fn();
    render(
      <SegmentedControl
        label="View"
        value="list"
        segments={segments}
        onChange={change}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(change).not.toHaveBeenCalled();
  });
});

describe("a typed confirmation whose action takes time", () => {
  /** Fails if the dialog closes on the click, which hid the pending state and any failure of a cascading delete. */
  it("stays open and pending until the action succeeds", async () => {
    let finish: () => void = () => undefined;
    const run = new Promise<void>((resolve) => (finish = resolve));
    const openChange = vi.fn();
    render(
      <DangerousConfirmDialog
        open
        title="Delete CustomResourceDefinition"
        confirmationText="widgets.example.com"
        confirmLabel="Delete"
        onOpenChange={openChange}
        onConfirm={() => run}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "widgets.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled()
    );
    expect(openChange).not.toHaveBeenCalledWith(false);
    finish();
    await waitFor(() => expect(openChange).toHaveBeenCalledWith(false));
  });

  /** Fails if the field arrives looking filled in with the very name it asks for. */
  it("leaves the field empty rather than showing the name as its placeholder", () => {
    render(
      <DangerousConfirmDialog
        open
        title="Delete CustomResourceDefinition"
        confirmationText="widgets.example.com"
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />
    );
    expect(screen.getByRole("textbox")).not.toHaveAttribute(
      "placeholder",
      "widgets.example.com"
    );
  });
});
