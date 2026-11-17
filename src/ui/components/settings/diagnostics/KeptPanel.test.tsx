import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithRouter } from "@/test/render";
import { KeptPanel } from "./KeptPanel";

let kept: { keep: boolean; bytes: number; clusters: number } | Error;
const calls: { command: string; args: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  kept = { keep: true, bytes: 3 * 1024 * 1024, clusters: 2 };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    calls.push({ command, args });
    if (command === "timeline_kept") {
      if (kept instanceof Error) throw kept;
      return kept;
    }
    if (command === "timeline_set_keep") {
      if (!(kept instanceof Error))
        kept = { ...kept, keep: (args as { keep: boolean }).keep };
      return undefined;
    }
    return undefined;
  });
});

describe("what the app keeps on this machine", () => {
  /** Fails if the size is not said, or keeping off is not said to keep what is there. */
  it("says how much is kept, and that off keeps it until cleared", async () => {
    await renderWithRouter(<KeptPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("kept-size")).toHaveTextContent("2 clusters")
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "Keep the timeline between restarts" })
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "timeline_set_keep",
        args: { keep: false },
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("kept-size")).toHaveTextContent(
        "Off: nothing more is written; what is kept stays until you clear it."
      )
    );
  });

  /** Fails if a clear goes out without the reader confirming it. */
  it("clears only once the reader confirms", async () => {
    await renderWithRouter(<KeptPanel />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Clear the timeline" })
    );
    expect(calls.some((call) => call.command === "timeline_clear")).toBe(false);
    const dialog = await screen
      .findByRole("alertdialog")
      .catch(() => screen.findByRole("dialog"));
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear the timeline"
    );
    await userEvent.click(confirm!);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "timeline_clear")).toBe(true)
    );
  });

  /**
   * The switch that could not save sprang back with no word, and the
   * rejection went unhandled. Fails if a failed switch does not say why.
   */
  it("says why the switch did not take", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "timeline_set_keep")
        throw new Error("config is read-only");
      return command === "timeline_kept" ? kept : undefined;
    });
    await renderWithRouter(<KeptPanel />);
    await userEvent.click(
      await screen.findByRole("switch", {
        name: "Keep the timeline between restarts",
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("keep-failed")).toHaveTextContent(
        /^Keeping was not changed: .*config is read-only/
      )
    );
  });

  /**
   * Nothing was kept at the first read, and the read after a switch failed:
   * the panel went on saying "Nothing kept yet." Fails if an earlier answer
   * hides a read that failed after it.
   */
  it("says a read that failed after an earlier answer, not the earlier answer", async () => {
    kept = { keep: true, bytes: 0, clusters: 0 };
    await renderWithRouter(<KeptPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("kept-size")).toHaveTextContent(
        "Nothing kept yet."
      )
    );
    kept = new Error("permission denied");
    await userEvent.click(
      screen.getByRole("switch", { name: "Keep the timeline between restarts" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("kept-size")).toHaveTextContent(
        /Could not read what is kept/
      )
    );
  });

  /** A size that could not be read is not "nothing kept". */
  it("says what is kept could not be read, rather than that nothing is", async () => {
    kept = new Error("permission denied");
    await renderWithRouter(<KeptPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("kept-size")).toHaveTextContent(
        /Could not read what is kept/
      )
    );
    expect(screen.getByTestId("kept-size")).not.toHaveTextContent(
      "Nothing kept yet."
    );
  });
});
