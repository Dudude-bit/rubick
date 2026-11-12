import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listeners: Record<
  string,
  Array<(event: { payload: unknown }) => void> | undefined
> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      (listeners[event] ??= []).push(handler);
      return () => {};
    }
  ),
}));

const commands = vi.hoisted(() => ({
  startNodeDrain: vi.fn(),
  cancelNodeDrain: vi.fn(),
  nodeDrainSubscribed: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({ commands }));
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ data: undefined, error: null, isPending: true }),
}));

import { useDrainEndings } from "@/hooks/useDrainEndings";
import { Toaster } from "@/components/ui/toaster";
import { namesRebound } from "@/lib/kept-by-name";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { useNodeActions } from "./useNodeActions";

/** A Nodes page as far as its drains go: a Drain per node, the mark, the dialog. */
function Nodes() {
  const actions = useNodeActions(null);
  return (
    <>
      {["node-a", "node-b"].map((node) => (
        <button key={node} type="button" onClick={() => actions.drain(node)}>
          {actions.draining(node) ? `${node} is draining` : `drain ${node}`}
        </button>
      ))}
      {actions.dialogs}
    </>
  );
}

/** What the window mounts whatever page is open. */
function Window({ page }: { page: boolean }) {
  useDrainEndings();
  return (
    <>
      {page ? <Nodes /> : <p>another page</p>}
      <Toaster />
    </>
  );
}

const open = (page = true) =>
  renderWithRouter(<Window page={page} />, {
    at: "/c/prod/nodes",
    route: "/c/$cluster/nodes",
  });

const finish = (drainId: string, node: string, outcome: string) =>
  act(() => {
    for (const handler of listeners["drain-finished"] ?? []) {
      handler({
        payload: {
          drain_id: drainId,
          node,
          outcome,
          report: {
            evicted: 2,
            alreadyGone: 0,
            leaving: 0,
            daemonsetPodsLeft: 0,
            staticPodsLeft: 0,
            refused: [],
          },
          message: null,
        },
      });
    }
  });

async function drain(node: string) {
  await userEvent.click(screen.getByRole("button", { name: `drain ${node}` }));
  await userEvent.click(await screen.findByRole("button", { name: "Drain" }));
  await screen.findByRole("button", { name: "Stop draining" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  act(() => namesRebound());
  vi.resetAllMocks();
  let started = 0;
  commands.startNodeDrain.mockImplementation(async () => ({
    drainId: `d${++started}`,
  }));
  commands.cancelNodeDrain.mockResolvedValue(undefined);
  commands.nodeDrainSubscribed.mockResolvedValue(undefined);
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

describe("a drain left running behind its dialog", () => {
  /**
   * Opening Drain on a second node reset the one drain the window held: the
   * first went on evicting with no mark and no Stop, and its row offered a
   * first-time confirmation that started a second drain beside it. Fails if
   * node-a's drain cannot be opened and stopped after node-b's dialog.
   */
  it("is still there, with its Stop, after another node's Drain was opened", async () => {
    await open();
    await drain("node-a");

    await userEvent.click(screen.getByRole("button", { name: "drain node-b" }));
    expect(
      await screen.findByRole("button", { name: "Drain" })
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(
      screen.getByRole("button", { name: "node-a is draining" })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop draining" })
    );

    expect(commands.cancelNodeDrain).toHaveBeenCalledWith("d1");
    expect(commands.startNodeDrain).toHaveBeenCalledTimes(1);
  });

  /**
   * Leaving the Nodes page unmounted the only holder of the drain, and the
   * page that came back started idle. Fails if a page mounted later does not
   * find the drain an earlier one started.
   */
  it("is found again by the page after the reader left it and came back", async () => {
    const first = await open();
    await drain("node-a");
    first.unmount();

    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "node-a is draining" })
    );

    expect(
      await screen.findByRole("button", { name: "Stop draining" })
    ).toBeInTheDocument();
    expect(commands.startNodeDrain).toHaveBeenCalledTimes(1);
  });

  /**
   * The ending was said by the page that started the drain and by nothing
   * else. Fails if a drain that ends while the reader is elsewhere ends
   * without a word, or if its report is gone when the node is opened again.
   */
  it("says it ended while the reader is on another page, and keeps what stayed to read", async () => {
    const first = await open();
    await drain("node-a");
    await first.rerender(<Window page={false} />);

    await finish("d1", "node-a", "stopped");
    expect(
      await screen.findByText("The drain of node-a ended")
    ).toBeInTheDocument();

    await first.rerender(<Window page />);
    await userEvent.click(screen.getByRole("button", { name: "drain node-a" }));
    expect(await screen.findByText("The drain stopped.")).toBeInTheDocument();
  });

  /** A node that emptied has nothing left to read. Fails if its dialog stays open on a drain that is over, or falls back to asking whether to drain. */
  it("closes the dialog of a node that emptied and says so", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "drain node-a" }));
    await userEvent.click(await screen.findByRole("button", { name: "Drain" }));
    await screen.findByRole("button", { name: "Stop draining" });

    await finish("d1", "node-a", "drained");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Node drained")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "drain node-a" })
    ).toBeInTheDocument();
  });
});
