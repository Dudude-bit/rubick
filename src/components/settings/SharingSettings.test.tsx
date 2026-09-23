import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: {
    listShareTargets: vi.fn(async () => []),
    saveShareTarget: vi.fn(async () => ({
      id: "t1",
      label: "internal",
      host: "plans.example.com",
      kind: "postplan",
      public: false,
      hasKey: true,
    })),
    removeShareTarget: vi.fn(async () => undefined),
    verifyShareTarget: vi.fn(async () => ({
      accountName: "a",
      apiKeyName: "k",
    })),
    importPostplanKey: vi.fn(async () => "…4d2e"),
  },
}));

import { commands } from "@/lib/commands";
import { renderWithProviders } from "@/test/render";
import { SharingSettings } from "./SharingSettings";

const wrap = () => renderWithProviders(<SharingSettings />);

beforeEach(() => {
  vi.mocked(commands.saveShareTarget).mockClear();
  vi.mocked(commands.importPostplanKey).mockClear();
});

describe("giving a publishing target its key", () => {
  /**
   * The import is answered a moment later, and the reader may have pressed
   * Cancel by then. Applying that answer to whatever form is open next put
   * one target's key into another target's row — or opened a form nobody
   * asked for.
   */
  it("does not land an import in the form the reader moved to", async () => {
    const user = userEvent.setup();
    let answer: (tail: string) => void = () => {};
    vi.mocked(commands.importPostplanKey).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve as (tail: string) => void;
      })
    );
    wrap();

    await user.click(await screen.findByRole("button", { name: /add|добав/i }));
    await user.click(screen.getByRole("button", { name: /postplan|import/i }));
    await user.click(screen.getByRole("button", { name: /cancel|отмен/i }));

    // Inside `act`, so the late answer is applied before this asserts —
    // otherwise the assertion passes whether the guard is there or not.
    await act(async () => {
      answer("…4d2e");
    });

    // No form reopened by an answer to a form that is gone.
    expect(screen.queryByLabelText(/key|ключ/i)).toBeNull();
  });

  /**
   * The import asks the backend to use the key it already holds, and the
   * save prefers that key over anything sent with it. So a reader who
   * imported and then typed a different key had the typed one ignored — and
   * on a machine whose CLI key had since gone, the save failed outright.
   */
  it("uses the key that was typed after an import, not the imported one", async () => {
    const user = userEvent.setup();
    wrap();

    await user.click(await screen.findByRole("button", { name: /add|добав/i }));
    await user.click(screen.getByRole("button", { name: /postplan|import/i }));
    const key = await screen.findByLabelText(/key|ключ/i);
    await user.type(key, "pp_typed_by_hand");
    await user.click(screen.getByRole("button", { name: /save|сохран/i }));

    expect(commands.saveShareTarget).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "pp_typed_by_hand", importKey: false })
    );
  });
});
