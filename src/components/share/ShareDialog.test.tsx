import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const save = vi.hoisted(() => vi.fn(async () => "/home/me/report.html"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@/lib/commands", () => ({
  commands: {
    writeTextFile: vi.fn(async () => undefined),
    listShareTargets: vi.fn(async () => targets.list),
    publishReport: vi.fn(async () => ({
      url: "https://abc123.postplan.dev",
      rawUrl: null,
      draftId: "abc123",
      version: 2,
    })),
  },
}));

const targets = vi.hoisted(() => ({
  list: [] as Array<{
    id: string;
    label: string;
    apiUrl: string;
    kind: string;
    public: boolean;
    hasKey: boolean;
    host: string;
  }>,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ShareDialog report={value} open onOpenChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// Radix's Select drives its listbox through pointer capture, which jsdom
// does not implement; without these the trigger never opens and the test
// would be asserting against a closed menu.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue("/home/me/report.html");
  targets.list = [];
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

describe("publishing", () => {
  const publicTarget = {
    id: "t-public",
    label: "postplan",
    apiUrl: "https://postplan.dev",
    kind: "postplan",
    public: true,
    hasKey: true,
    host: "postplan.dev",
  };
  const internal = {
    ...publicTarget,
    id: "t-internal",
    label: "internal",
    public: false,
    host: "plans.example.com",
  };

  /**
   * The one rule of a public target: the sentence is acknowledged for this
   * report, every time. A tick that survives switching targets or capturing
   * again would be consent to something the reader never read.
   */
  it("sends nothing to a public target until this report is acknowledged", async () => {
    targets.list = [publicTarget];
    mount();
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Target" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /postplan/ })
    );

    const publish = await screen.findByRole("button", { name: /Publish to/ });
    expect(publish).toBeDisabled();
    expect(
      screen.getByText(/Anyone with the link can read this/)
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand what leaves this machine/,
      })
    );
    expect(publish).toBeEnabled();
    await userEvent.click(publish);
    await waitFor(() =>
      expect(commands.publishReport).toHaveBeenCalledTimes(1)
    );
    const [targetId, object, filename, , html] = vi.mocked(
      commands.publishReport
    ).mock.calls[0];
    expect(targetId).toBe("t-public");
    // One link per object per target: the draft is remembered against this key.
    expect(object).toBe("Pod/shop/payments-7b6d9c5f4-x8k2p");
    expect(filename).toContain("payments-7b6d9c5f4-x8k2p");
    expect(html).toContain("<!doctype html>");
    expect(
      await screen.findByText("https://abc123.postplan.dev")
    ).toBeInTheDocument();
  });

  it("asks nothing extra of a target only your team can read", async () => {
    targets.list = [internal];
    mount();
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Target" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /internal/ })
    );
    expect(
      screen.queryByRole("checkbox", { name: /I understand/ })
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Publish to/ })
    ).toBeEnabled();
  });

  it("offers no publishing at all when no target is configured", async () => {
    targets.list = [];
    mount();
    expect(
      await screen.findByText(/No publishing target yet/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Publish to/ })
    ).not.toBeInTheDocument();
  });

  it("will not publish to a target whose key is missing", async () => {
    targets.list = [{ ...internal, hasKey: false }];
    mount();
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Target" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /internal/ })
    );
    expect(
      await screen.findByRole("button", { name: /Publish to/ })
    ).toBeDisabled();
    expect(screen.getByText(/has no key yet/)).toBeInTheDocument();
  });
});
