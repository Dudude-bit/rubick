import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => ({ data: { version: "4.18.0" } }),
}));
vi.mock("./ShareDialog", () => ({
  ShareDialog: ({
    report,
  }: {
    report: { capturedAt: string; notRead: string[]; link: string } | null;
  }) => (
    <>
      <p data-testid="captured">{report?.capturedAt ?? ""}</p>
      <p data-testid="not-read">{report?.notRead.join(" | ") ?? ""}</p>
      <p data-testid="link">{report?.link ?? ""}</p>
    </>
  ),
}));

import { renderWithRouter } from "@/test/render";
import { ScreenShareProvider, useShareSection } from "./screen-share";
import { ShareScreenAction } from "./ShareAction";

const mount = (ui: ReactNode) =>
  renderWithRouter(<ScreenShareProvider>{ui}</ScreenShareProvider>, {
    at: "/c/prod/nodes",
  });

/** A screen that re-renders on demand, handing Share a new object each time as a watch tick does. */
function Ticking() {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setTick(tick + 1)}>
        tick
      </button>
      <ShareScreenAction screen={{ title: "Nodes" }} />
    </>
  );
}

describe("a screen's Share while its dialog is open", () => {
  /** The dialog keys the public-target tick and the published link on
   *  `capturedAt`; a new one on every watch tick took both away mid-read. */
  it("keeps the moment it was captured when the screen re-renders", async () => {
    await mount(<Ticking />);
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    const first = screen.getByTestId("captured").textContent;
    expect(first).not.toBe("");

    await new Promise((resolve) => setTimeout(resolve, 5));
    fireEvent.click(screen.getByRole("button", { name: "tick" }));
    expect(screen.getByTestId("captured").textContent).toBe(first);
  });

  /**
   * The Traefik map registered nothing, and its file said "everything this
   * report names was read" over no sections at all: a screen that put
   * nothing in has to say so.
   */
  it("says nothing on the screen went into the file, when nothing did", async () => {
    await mount(<ShareScreenAction screen={{ title: "Traefik · Map" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(screen.getByTestId("not-read").textContent).toContain(
      "Nothing on this screen was put into the file"
    );
  });

  /**
   * The link in the file is the moment it was captured; stamped when the
   * report was built, it moved with every render and disagreed with the
   * dialog's own "captured".
   */
  it("stamps the link with the moment of capture", async () => {
    function Part() {
      useShareSection("part", () => ({
        id: "part",
        order: 20,
        title: "Part",
        icon: "",
        body: { type: "text", text: "x" },
      }));
      return null;
    }
    await mount(
      <>
        <Part />
        <ShareScreenAction screen={{ title: "Nodes" }} />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    const captured = screen.getByTestId("captured").textContent!;
    const t = new URL(screen.getByTestId("link").textContent!).searchParams.get(
      "t"
    );
    expect(t).toBe(captured.replace(/\.\d{3}Z$/, "Z"));
    expect(screen.getByTestId("not-read").textContent).toBe("");
  });
});
