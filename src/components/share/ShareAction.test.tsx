import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => ({ data: { version: "4.18.0" } }),
}));
vi.mock("./ShareDialog", () => ({
  ShareDialog: ({ report }: { report: { capturedAt: string } | null }) => (
    <p data-testid="captured">{report?.capturedAt ?? ""}</p>
  ),
}));

import { ScreenShareProvider } from "./screen-share";
import { ShareScreenAction } from "./ShareAction";

const wrap = (ui: ReactNode) => (
  <MemoryRouter>
    <ScreenShareProvider>{ui}</ScreenShareProvider>
  </MemoryRouter>
);

describe("a screen's Share while its dialog is open", () => {
  /** The dialog keys the public-target tick and the published link on
   *  `capturedAt`; a new one on every watch tick took both away mid-read. */
  it("keeps the moment it was captured when the screen re-renders", async () => {
    const { rerender } = render(
      wrap(<ShareScreenAction screen={{ title: "Nodes" }} />)
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    const first = screen.getByTestId("captured").textContent;
    expect(first).not.toBe("");

    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender(wrap(<ShareScreenAction screen={{ title: "Nodes" }} />));
    expect(screen.getByTestId("captured").textContent).toBe(first);
  });
});
