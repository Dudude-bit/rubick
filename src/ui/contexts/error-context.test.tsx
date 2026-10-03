import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { useClusterStore } from "@/stores/clusterStore";
import { ErrorProvider } from "./error-context";

beforeEach(() => {
  toast.mockClear();
  useClusterStore.setState({ error: null, errorContext: null });
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
