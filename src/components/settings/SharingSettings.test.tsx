import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
import { SharingSettings } from "./SharingSettings";

const wrap = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SharingSettings />
    </QueryClientProvider>
  );

beforeEach(() => {
  vi.mocked(commands.saveShareTarget).mockClear();
  vi.mocked(commands.importPostplanKey).mockClear();
});

describe("giving a publishing target its key", () => {
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
