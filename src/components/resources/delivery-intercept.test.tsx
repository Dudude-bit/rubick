import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshCw } from "lucide-react";

import { InterceptedAction } from "./delivery-intercept";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

const trigger = () => screen.getByRole("button", { name: /restart/i });

const action = (onClick: () => void) => (
  <InterceptedAction
    intercept={null}
    icon={RefreshCw}
    label="Restart"
    onClick={onClick}
  />
);

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("an intercepted action with nothing to intercept", () => {
  /**
   * On an ordinary cluster with no delivery controller the control is the
   * plain one it always was — a single click, no dialog interposed.
   */
  it("fires straight through on an ordinary cluster", async () => {
    useClusterStore.setState({ currentContext: "dev", isConnected: true });
    const onClick = vi.fn();
    render(action(onClick));

    await userEvent.click(trigger());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("an intercepted action on critical infrastructure", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: PROD, isConnected: true });
    useClusterIdentityStore.getState().setCritical(PROD, true);
  });

  /**
   * A restart with no delivery controller to warn about was the last change
   * that still fired on one click; the gate has to reach it too, or "before
   * any change" has a hole exactly where the reader would not look for one.
   */
  it("interposes the gate even with nothing to warn about", async () => {
    const onClick = vi.fn();
    render(action(onClick));

    await userEvent.click(trigger());
    expect(onClick).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(PROD);
    const confirm = within(dialog).getByRole("button", { name: /restart/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
