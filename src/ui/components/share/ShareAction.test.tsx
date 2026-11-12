import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";

vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => ({ data: { version: "4.18.0" } }),
}));
vi.mock("./ShareDialog", () => ({
  ShareDialog: ({
    report,
  }: {
    report: {
      capturedAt: string;
      notRead: string[];
      link: string;
      chips: { text: string }[];
      subject: { namespace: string | null };
    } | null;
  }) => (
    <>
      <p data-testid="chips">
        {report?.chips.map((chip) => chip.text).join(" | ") ?? ""}
      </p>
      <p data-testid="namespace">{report?.subject.namespace ?? ""}</p>
      <p data-testid="captured">{report?.capturedAt ?? ""}</p>
      <p data-testid="not-read">{report?.notRead.join(" | ") ?? ""}</p>
      <p data-testid="link">{report?.link ?? ""}</p>
    </>
  ),
}));

import { renderWithRouter } from "@/test/render";
import {
  ScreenShareProvider,
  useShareCaveat,
  useShareSection,
} from "./screen-share";
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
      <ShareScreenAction screen={{ title: "Nodes", scope: null }} />
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
    await mount(
      <ShareScreenAction screen={{ title: "Traefik · Map", scope: null }} />
    );
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
        <ShareScreenAction screen={{ title: "Nodes", scope: null }} />
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

  /**
   * A notice on screen said the rows were old, and the file said everything
   * it names was read. Fails if what a screen's notices say of its read is
   * left out of the file's Not read.
   */
  it("writes what the screen's own notices say of its read into Not read", async () => {
    function Notice() {
      useShareCaveat("Could not read pods when this was made");
      return null;
    }
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
        <Notice />
        <Part />
        <ShareScreenAction screen={{ title: "Pods", scope: null }} />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(screen.getByTestId("not-read").textContent).toBe(
      "Could not read pods when this was made"
    );
  });

  /**
   * The Overview of a tab on one namespace went out as "Overview", chip
   * prod, "nothing needs attention": the scope is the window's and was in
   * neither the address nor the rows, so the file read as the cluster.
   * Fails if the file stops naming every namespace the screen read.
   */
  it("names the namespaces the screen read beside the cluster", async () => {
    await mount(
      <ShareScreenAction
        screen={{ title: "Overview", scope: ["shop", "web"] }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(screen.getByTestId("chips").textContent).toMatch(/^shop, web \| /);
    expect(screen.getByTestId("namespace").textContent).toBe("");
  });

  it("names one namespace as the file's own, and none for the whole cluster", async () => {
    const one = await mount(
      <ShareScreenAction screen={{ title: "Pods", scope: ["shop"] }} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(screen.getByTestId("namespace").textContent).toBe("shop");
    expect(screen.getByTestId("chips").textContent).toMatch(/^shop \| /);
    one.unmount();

    await mount(<ShareScreenAction screen={{ title: "Pods", scope: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(screen.getByTestId("chips").textContent).not.toContain("|");
  });
});
