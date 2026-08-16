import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ----- Mocks -----

vi.mock("@/lib/commands", () => ({
  commands: {
    cancelAuthSession: vi.fn(async () => undefined),
  },
}));

// Stub the underlying Terminal child — we don't need a real xterm here.
// We DO want a way to fire its `onClose` callback synthetically, so we
// expose it via a data-testid trigger.
vi.mock("./Terminal", () => ({
  Terminal: ({
    sessionId,
    metadata,
    onClose,
  }: {
    sessionId: string;
    metadata: { title: string; subtitle: string };
    onClose: () => void;
  }) => (
    <div
      data-testid="terminal-stub"
      data-session-id={sessionId}
      data-subtitle={metadata.subtitle}
    >
      <button data-testid="terminal-stub-close" onClick={() => onClose()}>
        stub-close
      </button>
    </div>
  ),
}));

import { commands } from "@/lib/commands";
import { AuthTerminal } from "./AuthTerminal";

// ----- Helpers -----

const baseProps = {
  open: true,
  onClose: vi.fn(),
  authSessionId: "auth-1",
  terminalSessionId: "term-1",
  context: "orders-dev",
  command: "kubectl-oidc_login --server https://example",
};

function renderDialog(overrides: Partial<typeof baseProps> = {}) {
  const props = { ...baseProps, ...overrides, onClose: vi.fn() };
  const result = render(<AuthTerminal {...props} />);
  return { ...result, props };
}

// ----- Characterization tests -----
//
// These pin what AuthTerminal currently does. They MUST stay green
// across the upcoming terminal-auth subsystem rewrite — they describe
// the dialog's contract with its caller, not the broken backend.

describe("AuthTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Authentication Required dialog when open", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: /authentication required/i })
    ).toBeInTheDocument();
  });

  it("shows the cluster context name in the header", () => {
    renderDialog({ context: "production-eks" });
    // Header reads: "Context: production-eks"
    expect(screen.getByText("production-eks")).toBeInTheDocument();
  });

  it("shows the command line when provided", () => {
    const cmd = "kubectl-oidc_login --server https://idp.test";
    renderDialog({ command: cmd });
    expect(screen.getByText(cmd)).toBeInTheDocument();
  });

  it("hides the command row when command is an empty string", () => {
    renderDialog({ command: "" });
    expect(screen.queryByText(/^Command:/)).not.toBeInTheDocument();
  });

  it("forwards the terminal session id to the Terminal child", () => {
    renderDialog({ terminalSessionId: "term-xyz" });
    expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
      "data-session-id",
      "term-xyz"
    );
  });

  it("calls cancelAuthSession then onClose when Esc / overlay closes the dialog", async () => {
    const { props } = renderDialog();
    const user = userEvent.setup();

    // Radix Dialog: ESC triggers onOpenChange(false)
    await user.keyboard("{Escape}");

    expect(commands.cancelAuthSession).toHaveBeenCalledWith("auth-1");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the underlying Terminal emits onClose (process exited)", async () => {
    const { props } = renderDialog();
    const user = userEvent.setup();

    // Click the stub's close button to trigger the Terminal's onClose
    await user.click(screen.getByTestId("terminal-stub-close"));

    // Terminal-driven close does NOT cancel the auth session — backend
    // will emit AuthFlowCompleted or AuthFlowCancelled itself. Asserting
    // the contract: only onClose runs.
    expect(commands.cancelAuthSession).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing visible when open is false", () => {
    renderDialog({ open: false });
    expect(
      screen.queryByRole("heading", { name: /authentication required/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-stub")).not.toBeInTheDocument();
  });
});
