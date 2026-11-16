import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, within } from "@testing-library/react";
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
    forgetDiscovery: vi.fn(async () => undefined),
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

describe("the row under the Sharing heading", () => {
  /** The row repeated the section's own title and sentence word for word, right under them. */
  it("says something the heading above it does not", async () => {
    wrap();
    expect(await screen.findByText("Targets")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Where a report may be published, and the key that lets it."
      )
    ).toBeNull();
  });
});

describe("the list of share targets", () => {
  /**
   * A list still being read, and one that failed, both drew "No targets
   * yet", which sends the reader to add a target they already have. Fails if
   * either is said as an empty list.
   */
  it("says reading while it reads and could not read when it failed, never that there are none", async () => {
    let answer: (targets: unknown[]) => void = () => {};
    vi.mocked(commands.listShareTargets).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve as (targets: unknown[]) => void;
      }) as never
    );
    wrap();
    expect(
      await screen.findByText("Reading the list of targets…")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No targets yet/)).toBeNull();
    await act(async () => answer([]));
    expect(await screen.findByText(/No targets yet/)).toBeInTheDocument();
  });

  it("offers to read the list again when it could not be read", async () => {
    vi.mocked(commands.listShareTargets).mockRejectedValueOnce(
      new Error("refused")
    );
    wrap();
    expect(
      await screen.findByText("Could not read the list of targets.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No targets yet/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeInTheDocument();
  });

  /** Remove fired on the first click, so a double click removed twice. Fails if it runs before the confirmation. */
  it("removes a target only after it is confirmed", async () => {
    vi.mocked(commands.listShareTargets).mockResolvedValue([
      {
        id: "t1",
        label: "internal",
        host: "plans.example.com",
        kind: "postplan",
        public: false,
        hasKey: true,
        apiUrl: "https://plans.example.com",
      },
    ] as never);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(commands.removeShareTarget).not.toHaveBeenCalled();
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      })
    );
    expect(commands.removeShareTarget).toHaveBeenCalledWith("t1");
  });
});
