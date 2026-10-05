import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ----- Mocks -----

const deletePortForwardConfig = vi.fn(async (_id: string) => undefined);
const updatePortForwardConfig = vi.fn(async (id: string) => ({
  id,
  context: "k3d",
  name: "renamed",
  pod: "api-7f9",
  namespace: "default",
  local_port: 8080,
  remote_port: 80,
  auto_reconnect: true,
  auto_start: false,
  created_at: "now",
}));

const toast = vi.fn();
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast }),
  toast: (...args: unknown[]) => toast(...args),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listPortForwardConfigs: vi.fn(async () => []),
    listPortForwards: vi.fn(async () => []),
    deletePortForwardConfig: (...args: [string]) =>
      deletePortForwardConfig(...args),
    updatePortForwardConfig: (...args: [string]) =>
      updatePortForwardConfig(...args),
    createPortForwardConfig: vi.fn(),
    portForwardPod: vi.fn(),
    stopPortForward: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { renderWithRouter } from "@/test/render";
import { PortForwardsTab } from "./PortForwardsTab";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";

// ----- Fixtures -----

const CONFIG = {
  id: "cfg-1",
  context: "k3d",
  name: "Auth API",
  pod: "api-7f9",
  namespace: "default",
  localPort: 8080,
  remotePort: 80,
  autoReconnect: true,
  autoStart: false,
  createdAt: "now",
};

const SESSION = {
  id: "sess-1",
  context: "k3d",
  pod: "api-7f9",
  namespace: "default",
  localPort: 8080,
  remotePort: 80,
  autoReconnect: true,
  createdAt: "now",
  via: { kind: "pod" as const },
};

function mount() {
  return renderWithRouter(<PortForwardsTab />, {
    at: "/c/k3d",
    route: "/c/$cluster/$",
  });
}

describe("PortForwardsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useClusterStore.setState({ currentContext: "k3d" });
    usePortForwardStore.setState({
      configs: [CONFIG],
      sessions: [SESSION],
      statusBySession: {},
      failed: [],
      configsLoaded: true,
    });
  });

  it("lists a forward that is running right now", async () => {
    await mount();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Stop forwarding api-7f9/ })
    ).toBeInTheDocument();
  });

  // Settings used to be the only place a saved forward could be created,
  // renamed, repointed or deleted. Deleting that page without these would
  // have stranded every saved config the app already holds.
  it("opens an editor for a saved forward", async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(
      screen.getByRole("button", { name: /More actions for Auth API/ })
    );
    await user.click(await screen.findByRole("menuitem", { name: /Edit/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Edit port forward");
    expect(screen.getByLabelText("Pod")).toHaveValue("api-7f9");
    expect(screen.getByLabelText("Local port")).toHaveValue(8080);
  });

  it("saves a repointed forward through the store", async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(
      screen.getByRole("button", { name: /More actions for Auth API/ })
    );
    await user.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    await user.clear(await screen.findByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updatePortForwardConfig).toHaveBeenCalledWith(
        "cfg-1",
        expect.objectContaining({ name: "renamed" })
      )
    );
  });

  it("deletes a saved forward", async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(
      screen.getByRole("button", { name: /More actions for Auth API/ })
    );
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));

    await waitFor(() =>
      expect(deletePortForwardConfig).toHaveBeenCalledWith("cfg-1")
    );
  });

  it("offers a new forward without sending the reader to another page", async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole("button", { name: /New/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "New port forward"
    );
  });

  /** A saved forward on a low port failed with the OS's English sentence. */
  it("says how to fix a saved forward whose local port needs administrator rights", async () => {
    vi.mocked(commands.portForwardPod).mockRejectedValueOnce({
      code: "LOCAL_PORT_PRIVILEGED",
      message: "Local port 80 needs administrator rights",
    });
    usePortForwardStore.setState({
      configs: [{ ...CONFIG, localPort: 80 }],
      sessions: [],
    });
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole("button", { name: "Start Auth API" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description:
            "Port 80 needs administrator rights on this machine. Use 8080 or leave it empty to pick a free one.",
        })
      )
    );
  });

  describe("a forward whose pod was replaced", () => {
    /**
     * The reported bug: after a restart the row stayed green against a pod
     * that no longer existed. Fails if a move does not rename the row.
     */
    it("names the pod it moved to, and what it follows", async () => {
      usePortForwardStore.setState({
        sessions: [
          {
            ...SESSION,
            via: { kind: "owner", ownerKind: "Deployment", name: "api" },
          },
        ],
      });
      await mount();

      act(() => {
        usePortForwardStore.getState().moved("sess-1", "api-55f", 80);
        usePortForwardStore.getState().setStatus({
          id: "sess-1",
          pod: "api-55f",
          namespace: "default",
          localPort: 8080,
          remotePort: 80,
          status: "moved",
          note: { says: "moved", from: "api-7f9" },
        });
      });

      const running = screen.getByText("Running").closest("section");
      expect(running).toHaveTextContent("api-55f");
      expect(running).not.toHaveTextContent(/^api-7f9/);
      expect(running).toHaveTextContent("via Deployment api");
      expect(screen.getByText("moved here from api-7f9")).toBeInTheDocument();
    });

    /**
     * With nothing to move to, the forward ends: it leaves Running, and the
     * reason stays on screen in the error tone instead of the row vanishing
     * like one somebody stopped.
     */
    it("leaves Running and says why it ended when there is nothing to move to", async () => {
      await mount();

      act(() => {
        usePortForwardStore
          .getState()
          .fail("sess-1", { says: "podGone", pod: "api-7f9" });
      });

      expect(screen.queryByText("Running")).not.toBeInTheDocument();
      const reason = screen.getByText("pod api-7f9 was deleted");
      expect(reason).toHaveClass("text-err");
      expect(screen.getByText("Ended")).toBeInTheDocument();

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Dismiss api-7f9" }));
      expect(screen.queryByText("pod api-7f9 was deleted")).toBeNull();
    });
  });

  describe("a forward belonging to another cluster", () => {
    const ELSEWHERE = {
      ...SESSION,
      id: "sess-2",
      context: "staging",
      pod: "billing-4c1",
    };

    /**
     * Would break if Running went back to listing every context at once —
     * the reader reads it as "running against the cluster I am looking at",
     * and a forward from another one silently made that false.
     */
    it("is kept out of Running", async () => {
      usePortForwardStore.setState({ sessions: [SESSION, ELSEWHERE] });
      await mount();

      const running = screen.getByText("Running").closest("section");
      expect(running).toHaveTextContent("api-7f9");
      expect(running).not.toHaveTextContent("billing-4c1");
    });

    /**
     * ...and not deleted either. It is a live process holding a local port;
     * a panel that omitted it would be lying about what is on the machine.
     */
    it("is listed under a group that says where it is", async () => {
      usePortForwardStore.setState({ sessions: [SESSION, ELSEWHERE] });
      await mount();

      expect(screen.getByText("Running elsewhere")).toBeInTheDocument();
      expect(screen.getByText("billing-4c1")).toBeInTheDocument();
      // The cluster's name is spent where it discriminates, and only there.
      expect(screen.getByText(/staging ·/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Stop forwarding billing-4c1/ })
      ).toBeInTheDocument();
    });

    /**
     * The pod route would resolve against the cluster the reader is in —
     * a different pod with the same name, or none at all.
     */
    it("does not offer its pod as a link into the current cluster", async () => {
      usePortForwardStore.setState({ sessions: [ELSEWHERE] });
      await mount();

      expect(screen.getByText("billing-4c1")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /billing-4c1/ })).toBeNull();
    });

    it("shows no Running group at all when every forward is elsewhere", async () => {
      usePortForwardStore.setState({ sessions: [ELSEWHERE] });
      await mount();

      expect(screen.queryByText("Running")).not.toBeInTheDocument();
      expect(screen.getByText("Running elsewhere")).toBeInTheDocument();
    });
  });
});
