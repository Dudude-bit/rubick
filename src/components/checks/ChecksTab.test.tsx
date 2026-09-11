import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { runPodCheck: vi.fn() },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import type { CheckOutcome, PodInfo } from "@/generated/types";
import { ChecksTab } from "./ChecksTab";

const pod = {
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
  uid: "u1",
  containers: [
    {
      name: "payments",
      state: { type: "running" },
      restartCount: 0,
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as PodInfo;

const outcome = (over: Partial<CheckOutcome>): CheckOutcome => ({
  ranIn: "container",
  tried: ["nc"],
  answeredWith: "nc",
  ok: true,
  toolMissing: false,
  exitCode: 0,
  stdout: "",
  stderr: "",
  elapsedMs: 9,
  copy: null,
  ...over,
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ChecksTab pod={pod} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(commands.runPodCheck).mockReset();
});

describe("testing a hypothesis from the pod", () => {
  it("asks the pod's own container first, with the host and port typed", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(outcome({}));
    mount();
    await userEvent.type(screen.getByLabelText(/Connect to/), "postgres:5432");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[1]);

    await waitFor(() => expect(commands.runPodCheck).toHaveBeenCalledTimes(1));
    const [name, namespace, container, check, copy] = vi.mocked(
      commands.runPodCheck
    ).mock.calls[0];
    expect([name, namespace, container]).toEqual([
      "payments-7b6d9c5f4-x8k2p",
      "shop",
      "payments",
    ]);
    expect(check).toEqual({ kind: "tcp", host: "postgres", port: 5432 });
    expect(copy).toBeNull();
    expect(
      await screen.findByText(/accepts a connection from here/)
    ).toBeVisible();
    expect(screen.getByText(/in the pod's own container/)).toBeVisible();
  });

  /**
   * An image with no tool is not a failed check, and the way out is offered
   * beside the answer: the same question from a copy, which says it is one.
   */
  it("offers a copy when the image has no tool, and says the answer came from one", async () => {
    vi.mocked(commands.runPodCheck)
      .mockResolvedValueOnce(
        outcome({
          toolMissing: true,
          answeredWith: null,
          ok: false,
          tried: ["getent", "nslookup", "host"],
        })
      )
      .mockResolvedValueOnce(
        outcome({
          ranIn: "copy",
          answeredWith: "nslookup",
          stdout: "Name:\tpostgres\nAddress: 10.96.12.4\n",
          copy: {
            pod: "payments-7b6d9c5f4-x8k2p-check-1",
            image: "busybox:1.36",
            deleted: true,
          },
        })
      );
    mount();
    await userEvent.type(screen.getByLabelText(/Resolve/), "postgres");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[0]);

    expect(await screen.findByText(/nothing to ask with/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: /Run from a copy/ })
    );

    await waitFor(() => expect(commands.runPodCheck).toHaveBeenCalledTimes(2));
    expect(vi.mocked(commands.runPodCheck).mock.calls[1][4]).toEqual({
      image: "busybox:1.36",
    });
    expect(await screen.findByText(/resolves to 10.96.12.4/)).toBeVisible();
    expect(
      screen.getByText(
        /in a copy of the pod running busybox:1.36, deleted afterwards/
      )
    ).toBeVisible();
  });

  it("will not run a connection check on an address with no port", async () => {
    mount();
    await userEvent.type(screen.getByLabelText(/Connect to/), "postgres");
    expect(screen.getAllByRole("button", { name: /Run/ })[1]).toBeDisabled();
    expect(commands.runPodCheck).not.toHaveBeenCalled();
  });
});
