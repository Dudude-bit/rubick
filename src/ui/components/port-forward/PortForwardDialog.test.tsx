import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const session = (localPort: number) => ({
  id: "pf-1",
  context: "prod",
  pod: "hello-web-0",
  namespace: "lena-sandbox",
  localPort,
  remotePort: 80,
  autoReconnect: true,
  createdAt: "now",
  via: { kind: "pod" as const },
});

vi.mock("@/lib/commands", () => ({
  commands: {
    portForwardPod: vi.fn(),
    portForwardService: vi.fn(),
    portForwardSubscribed: vi.fn(async () => undefined),
    createPortForwardConfig: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { renderWithRouter } from "@/test/render";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { PortForwardDialog, type ForwardTarget } from "./PortForwardDialog";

const POD: ForwardTarget = {
  kind: "Pod",
  name: "hello-web-0",
  namespace: "lena-sandbox",
  ports: [{ port: 80, name: "http", protocol: "TCP" }],
};

const mount = (target: ForwardTarget = POD) =>
  renderWithRouter(
    <PortForwardDialog open onOpenChange={() => {}} target={target} />
  );

beforeEach(() => {
  vi.clearAllMocks();
  usePortForwardStore.setState({
    sessions: [],
    configs: [],
    statusBySession: {},
    failed: [],
  });
});

describe("the port-forward dialog", () => {
  /** A container on 80 seeded local 80, which a normal user cannot listen on,
   *  and the address was only learned after starting. */
  it("offers a local port a normal user can bind, and says the address first", async () => {
    await mount();

    expect(screen.getByLabelText("Local port")).toHaveValue(8080);
    expect(screen.getByLabelText("Port in the pod")).toHaveValue(80);
    expect(screen.getByText("http://localhost:8080")).toBeInTheDocument();
  });

  /** "Failed to bind port 80: Permission denied (os error 13)" reached the
   *  reader in English with no fix. */
  it("turns a refused low port into the fix, and keeps the dialog open", async () => {
    vi.mocked(commands.portForwardPod).mockRejectedValueOnce({
      code: "LOCAL_PORT_PRIVILEGED",
      message: "Local port 80 needs administrator rights: Permission denied",
    });
    const user = userEvent.setup();
    await mount();
    await user.clear(screen.getByLabelText("Local port"));
    await user.type(screen.getByLabelText("Local port"), "80");
    await user.click(
      screen.getByRole("button", { name: "Start port-forward" })
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Port 80 needs administrator rights on this machine. Use 8080 or leave it empty to pick a free one."
    );
    await user.click(screen.getByRole("button", { name: "Use 8080" }));
    expect(screen.getByLabelText("Local port")).toHaveValue(8080);
  });

  /** Empty asks the machine for a free port rather than failing validation. */
  it("sends an empty local port as zero, a free one", async () => {
    vi.mocked(commands.portForwardPod).mockResolvedValueOnce(session(43117));
    const user = userEvent.setup();
    await mount();
    await user.clear(screen.getByLabelText("Local port"));
    expect(
      screen.getByText("Opens on a free local port, picked when it starts.")
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Start port-forward" })
    );

    await waitFor(() =>
      expect(commands.portForwardPod).toHaveBeenCalledWith(
        "hello-web-0",
        "lena-sandbox",
        { localPort: 0, remotePort: 80, autoReconnect: true }
      )
    );
  });

  /** "Ports must be between 1 and 65535" never said which one. */
  it("names the field that is wrong", async () => {
    const user = userEvent.setup();
    await mount();
    await user.clear(screen.getByLabelText("Port in the pod"));
    await user.click(
      screen.getByRole("button", { name: "Start port-forward" })
    );

    expect(
      screen.getByText("The port is a number from 1 to 65535.")
    ).toBeInTheDocument();
    expect(commands.portForwardPod).not.toHaveBeenCalled();
  });

  /** A Service is forwarded as itself, so the backend can follow it to the
   *  next pod; the pod it lands on is not chosen here. */
  it("forwards a Service through the Service, not through a pod it picked", async () => {
    vi.mocked(commands.portForwardService).mockResolvedValueOnce(session(8080));
    const user = userEvent.setup();
    await mount({
      kind: "Service",
      name: "hello-web",
      namespace: "lena-sandbox",
      ports: [{ port: 80, name: null, protocol: "TCP" }],
    });
    expect(screen.getByLabelText("Service port")).toHaveValue(80);
    await user.click(
      screen.getByRole("button", { name: "Start port-forward" })
    );

    await waitFor(() =>
      expect(commands.portForwardService).toHaveBeenCalledWith(
        "hello-web",
        "lena-sandbox",
        { localPort: 8080, remotePort: 80, autoReconnect: true }
      )
    );
    expect(commands.portForwardPod).not.toHaveBeenCalled();
  });
});
