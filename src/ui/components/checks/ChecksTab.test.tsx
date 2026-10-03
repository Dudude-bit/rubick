import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: { runPodCheck: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { renderWithProviders } from "@/test/render";
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
  answer: "yes",
  exitCode: 0,
  stdout: "",
  stderr: "",
  elapsedMs: 9,
  copy: null,
  ...over,
});

function mount(subject: PodInfo = pod) {
  return renderWithProviders(<ChecksTab pod={subject} />);
}

/** One container, crash-looping — the pod this tab is most opened on. */
const crashing = {
  ...pod,
  containers: [
    {
      name: "payments",
      state: { type: "waiting", reason: "CrashLoopBackOff" },
      lastTerminated: { exitCode: 1, reason: "Error" },
      restartCount: 7,
      phase: "app",
    },
  ],
} as unknown as PodInfo;

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
   * The two verdicts this tab exists to deliver, and neither was rendered by
   * any test: I rewrote `sentence()` so `notResolved` returned the words of
   * `resolved` and the whole suite stayed green. A tab that says a name
   * resolves when it does not is worse than no tab.
   */
  it("says a name does not resolve, in the words for that and not another", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(
      outcome({
        tried: ["getent"],
        answeredWith: "getent",
        answer: "no",
        exitCode: 2,
        stdout: "** server can't find db.shop: NXDOMAIN",
      })
    );
    mount();
    await userEvent.type(screen.getByLabelText(/Resolve/), "db.shop");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[0]);

    expect(await screen.findByText(/does not resolve from here/)).toBeVisible();
    expect(screen.queryByText(/resolves to/)).toBeNull();
  });

  it("says a port does not answer, and not that it accepted", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(
      outcome({ answer: "no", exitCode: 7 })
    );
    mount();
    await userEvent.type(screen.getByLabelText(/Connect to/), "db:5432");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[1]);

    expect(await screen.findByText(/does not answer from here/)).toBeVisible();
    expect(screen.queryByText(/accepts a connection/)).toBeNull();
  });

  /**
   * `CopyReport.deleted` is documented as "confirmed gone, not merely asked
   * to go", and its false case has its own words. Nothing fed `false`, so
   * an escaped copy was reported as cleaned up — about a pod still running
   * in the reader's namespace.
   */
  it("does not report a copy as deleted when the delete was not confirmed", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(
      outcome({
        ranIn: "copy",
        copy: {
          pod: "k8s-gui-check-payments-abc",
          image: "busybox",
          deleted: false,
        } as CheckOutcome["copy"],
      })
    );
    mount();
    await userEvent.type(screen.getByLabelText(/Connect to/), "db:5432");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[1]);

    expect(await screen.findByText(/not confirmed deleted/)).toBeVisible();
    expect(screen.queryByText(/deleted afterwards/)).toBeNull();
  });

  /**
   * An image with no tool is not a failed check, and the way out is offered
   * beside the answer: the same question from a copy, which says it is one.
   */
  it("offers a copy when the image has no tool, and says the answer came from one", async () => {
    vi.mocked(commands.runPodCheck)
      .mockResolvedValueOnce(
        outcome({
          answer: "noTool",
          answeredWith: null,
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

  /**
   * The container chooser carries the judgement, and it renders only for a
   * pod with more than one container — so on a one-container pod nothing
   * said the exec could not land, Run was offered anyway, and the reader got
   * the API server's refusal in the red line instead of an answer. The copy
   * is the route that still works.
   */
  it("says a container cannot take an exec, and runs from a copy instead", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(
      outcome({ ranIn: "copy" })
    );
    mount(crashing);

    expect(screen.getByText(/cannot take an exec/)).toBeVisible();

    await userEvent.type(screen.getByLabelText(/Resolve/), "db.shop");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[0]);

    await waitFor(() => {
      expect(commands.runPodCheck).toHaveBeenCalledWith(
        crashing.name,
        crashing.namespace,
        "payments",
        { kind: "dns", name: "db.shop" },
        expect.objectContaining({ image: expect.any(String) })
      );
    });
  });

  /**
   * `unanswered` is the verdict the library defines as a finding about the
   * attempt, not about the cluster — and it was painted the same amber as
   * "does not answer from here". A reader scanning the list by colour read
   * both as the cluster having a problem, where the first sentence says the
   * opposite in words.
   */
  it("does not paint a check that produced no answer as a finding about the cluster", async () => {
    vi.mocked(commands.runPodCheck).mockResolvedValue(
      outcome({ answer: "unanswered", exitCode: null })
    );
    mount();
    await userEvent.type(screen.getByLabelText(/Connect to/), "db:5432");
    await userEvent.click(screen.getAllByRole("button", { name: /Run/ })[1]);

    const said = await screen.findByText(/ended without saying/);
    expect(said.className).toContain("text-fg-mut");
    expect(said.className).not.toContain("text-warn");
  });
});
