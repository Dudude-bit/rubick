import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { useClusterStore } from "@/stores/clusterStore";
import { ErrorProvider } from "./error-context";

beforeEach(() => {
  toast.mockClear();
  useClusterStore.setState({ error: null, errorContext: null, failures: {} });
});

describe("the toast for a failure nobody caught", () => {
  /**
   * The toast took the logged form, so a command rejected with nothing
   * awaiting it read "Tauri command 'listPods' failed:" before the server's
   * words. Fails if the description is built from `reportError`'s message.
   */
  it("gives the server's words without the command in front", () => {
    render(
      <ErrorProvider>
        <span />
      </ErrorProvider>
    );
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.assign(event, {
      reason: new Error(
        'Tauri command \'listPods\' failed: pods is forbidden: User "kirya" cannot list resource "pods"'
      ),
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].description).toBe(
      'pods is forbidden: User "kirya" cannot list resource "pods"'
    );
  });
});

describe("the toast for a cluster that could not be reached", () => {
  /**
   * Dana's toast read "Network error / Connection error: Failed to get
   * server version: ServiceError: client error (Connect): deadline has
   * elapsed", the text the page folds under Details. Fails if any of the
   * server's words reach the toast.
   */
  it("names the cluster and leaves the raw error to the page's Details", () => {
    render(
      <ErrorProvider>
        <span />
      </ErrorProvider>
    );
    act(() => {
      useClusterStore.setState({
        error:
          "Connection error: Failed to get server version: ServiceError: client error (Connect): deadline has elapsed",
        errorContext: "acme-prod-eu",
      });
    });

    expect(toast).toHaveBeenCalledTimes(1);
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("Could not connect to acme-prod-eu");
    expect(JSON.stringify(shown)).not.toMatch(
      /ServiceError|deadline|Network error/
    );
  });

  /**
   * Live round 24: the toast was the one trace a failed connect left, and it
   * said only that it failed. Fails if it stops saying why, in the plain
   * words the failed page leads with.
   */
  it("says why in plain words", () => {
    useClusterStore.setState({
      contexts: [
        {
          name: "acme-prod-eu",
          server: "https://10.255.255.1:6443",
          exec_command: null,
        },
      ] as never,
    });
    render(
      <ErrorProvider>
        <span />
      </ErrorProvider>
    );
    act(() => {
      useClusterStore.setState({
        error: "Connection error: deadline has elapsed",
        errorContext: "acme-prod-eu",
        failures: {
          "acme-prod-eu": {
            kind: "timeout",
            error: "Connection error: deadline has elapsed",
          },
        },
      });
    });

    expect(toast.mock.calls[0][0].description).toBe(
      "10.255.255.1:6443 did not answer in time. It may be off, or reachable only through a VPN."
    );
  });
});
