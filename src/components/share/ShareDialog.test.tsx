import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const save = vi.hoisted(() => vi.fn(async () => "/home/me/report.html"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@/lib/commands", () => ({
  commands: { writeTextFile: vi.fn(async () => undefined) },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import type { Report } from "@/lib/report";
import { ShareDialog } from "./ShareDialog";

const report: Report = {
  subject: {
    kind: "Pod",
    name: "payments-7b6d9c5f4-x8k2p",
    namespace: "shop",
    context: "prod-eu-1",
  },
  capturedAt: "2026-09-09T18:12:03.001Z",
  appVersion: "4.10.0",
  verdict:
    "Most likely: it cannot reach its database, and probably exits on that.",
  facts: [{ label: "Status", value: "CrashLoopBackOff" }],
  chain: [],
  changes: [],
  logs: [{ source: "p/app", lines: ["ERROR refused"], previous: true }],
  notRead: ["NetworkPolicy in shop (403)"],
  link: "rubick://open/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p",
  words: {
    title: "Investigation",
    captured: "captured",
    openInRubick: "Open in Rubick",
    linkFallback: "Paste this into its search:",
    verdict: "Most likely",
    facts: "Facts",
    chain: "Traffic chain at capture",
    changes: "What changed",
    logs: "Log lines",
    notRead: "Not read",
    nothingHere: "Nothing here.",
    previousRun: "previous run",
    notLookedAt: "not looked at",
    madeBy: "Made by Rubick",
    noSecrets: "No Secret value is ever written into this file.",
  },
};

function mount(value: Report | null = report) {
  return render(
    <TooltipProvider>
      <ShareDialog report={value} open onOpenChange={() => {}} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue("/home/me/report.html");
});

describe("ShareDialog", () => {
  /** Saving is the whole of it: one file, named after the object, with the rendered report inside. */
  it("writes the rendered file to the path the reader picked", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Save as HTML/ }));

    await waitFor(() =>
      expect(commands.writeTextFile).toHaveBeenCalledTimes(1)
    );
    expect(save).toHaveBeenCalledWith({
      defaultPath: "shop-payments-7b6d9c5f4-x8k2p-2026-09-09T18-12-03-001.html",
    });
    const [path, html] = vi.mocked(commands.writeTextFile).mock.calls[0];
    expect(path).toBe("/home/me/report.html");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("payments-7b6d9c5f4-x8k2p");
    expect(html).toContain("ERROR refused");
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    save.mockResolvedValue(null as unknown as string);
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Save as HTML/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(commands.writeTextFile).not.toHaveBeenCalled();
  });

  /** What is going into the file is on screen before it leaves: the counts, and what could not be read. */
  it("shows what the file will carry, with the unread count as a warning", () => {
    mount();
    const preview = screen.getByTestId("share-preview");
    expect(preview.textContent).toContain("Most likely");
    expect(preview.textContent).toContain("Not read");
    expect(
      screen.getByText(/No Secret value is ever written/)
    ).toBeInTheDocument();
  });

  it("offers nothing to save when there is no report yet", () => {
    mount(null);
    expect(screen.getByRole("button", { name: /Save as HTML/ })).toBeDisabled();
  });
});
