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

  /** Fails if a failed action closes the dialog, or keeps it open without saying why, leaving only a toast. */
  it("stays open when the action fails and says why inside it", async () => {
    const openChange = vi.fn();
    render(
      dialog(
        () => Promise.reject(new Error("deployments.apps is forbidden")),
        openChange
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled()
    );
    expect(openChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByText("deployments.apps is forbidden")
    ).toBeInTheDocument();
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

  /** Fails if a refused delete leaves the typed dialog as it was, the failure only in a toast that invited a second press. */
  it("says inside the dialog why the action failed", async () => {
    render(
      <DangerousConfirmDialog
        open
        title="Restart pod"
        confirmationText="api-6bc99687fc-ssxg2"
        confirmLabel="Restart"
        onOpenChange={() => undefined}
        onConfirm={() => Promise.reject(new Error('pods "api" is forbidden'))}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "api-6bc99687fc-ssxg2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(
      await screen.findByText('pods "api" is forbidden')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The cluster refused it:|It did not go through:/)
    ).toBeInTheDocument();
  });

  /** Fails if Enter in a field holding the right name does nothing, which made typing the name then pressing Enter a dead end. */
  it("confirms on Enter once the typed name matches", async () => {
    const confirm = vi.fn(() => Promise.resolve());
    render(
      <DangerousConfirmDialog
        open
        title="Restart pod"
        confirmationText="api-6bc99687fc-ssxg2"
        confirmLabel="Restart"
        onOpenChange={() => undefined}
        onConfirm={confirm}
      />
    );
    const field = screen.getByRole("textbox");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "api-6bc99687fc-ssxg2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  });

  /** Fails if a second Enter after a refused delete sends the delete again, as the proxy saw twice. */
  it("does not ask a refused write again on a second Enter", async () => {
    const confirm = vi.fn(() => Promise.reject(new Error("forbidden")));
    render(
      <DangerousConfirmDialog
        open
        title="Delete ConfigMap"
        confirmationText="app-config"
        confirmLabel="Delete"
        onOpenChange={() => undefined}
        onConfirm={confirm}
      />
    );
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "app-config" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByText("forbidden");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(confirm).toHaveBeenCalledOnce();
  });
});
