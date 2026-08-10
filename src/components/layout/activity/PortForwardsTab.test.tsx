import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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
};

function mount() {
  return render(
    <MemoryRouter>
      <PortForwardsTab />
    </MemoryRouter>
  );
}

describe("PortForwardsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useClusterStore.setState({ currentContext: "k3d" });
    usePortForwardStore.setState({
      configs: [CONFIG],
      sessions: [SESSION],
      statusBySession: {},
      configsLoaded: true,
    });
  });

  it("lists a forward that is running right now", () => {
    mount();
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
    mount();

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
    mount();

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
    mount();

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
    mount();

    await user.click(screen.getByRole("button", { name: /New/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "New port forward"
    );
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
    it("is kept out of Running", () => {
      usePortForwardStore.setState({ sessions: [SESSION, ELSEWHERE] });
      mount();

      const running = screen.getByText("Running").closest("section");
      expect(running).toHaveTextContent("api-7f9");
      expect(running).not.toHaveTextContent("billing-4c1");
    });

    /**
     * ...and not deleted either. It is a live process holding a local port;
     * a panel that omitted it would be lying about what is on the machine.
     */
    it("is listed under a group that says where it is", () => {
      usePortForwardStore.setState({ sessions: [SESSION, ELSEWHERE] });
      mount();

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
    it("does not offer its pod as a link into the current cluster", () => {
      usePortForwardStore.setState({ sessions: [ELSEWHERE] });
      mount();

      expect(screen.getByText("billing-4c1")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /billing-4c1/ })).toBeNull();
    });

    it("shows no Running group at all when every forward is elsewhere", () => {
      usePortForwardStore.setState({ sessions: [ELSEWHERE] });
      mount();

      expect(screen.queryByText("Running")).not.toBeInTheDocument();
      expect(screen.getByText("Running elsewhere")).toBeInTheDocument();
    });
  });
});
