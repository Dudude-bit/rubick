import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));

import { AppearanceSettings } from "./AppearanceSettings";
import { useLocaleStore } from "@/stores/localeStore";

describe("the language picker", () => {
  /**
   * A catalogue that fails to load left the picker on the old language with
   * nothing said, and an unhandled rejection in the console.
   */
  it("says why the language did not change", async () => {
    useLocaleStore.setState({
      setChoice: () => Promise.reject(new Error("chunk ru failed")),
    });
    render(<AppearanceSettings />);

    const picker = screen.getByRole("combobox", { name: /language/i });
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Русский/ }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "chunk ru failed" })
      )
    );
  });
});
