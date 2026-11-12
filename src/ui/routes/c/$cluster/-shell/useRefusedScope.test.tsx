import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";

const list = vi.hoisted(() => ({
  state: "refused" as "refused" | "listed",
}));

vi.mock("@/hooks/useClusterSummary", () => ({
  useNamespaceList: () => ({ data: undefined, state: list.state }),
}));

vi.mock("@/lib/commands", () => ({
  commands: { saveClusterPreferences: vi.fn(async () => undefined) },
}));

import { SCOPE_PICKER_OPEN } from "@/lib/read-deadline";
import { useClusterStore } from "@/stores/clusterStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";
import type { ContextInfo } from "@/generated/types";
import { useRefusedScope } from "./useRefusedScope";

const scope = () => useClusterStore.getState().namespaceScope;

beforeEach(() => {
  list.state = "refused";
  useNamespaceRecencyStore.setState({ recent: {} });
  useClusterStore.setState({
    contexts: [{ name: "dev" }] as unknown as ContextInfo[],
    currentContext: "dev",
    namespaceScope: [],
    currentNamespace: "",
    connectionAttemptId: 1,
  });
});

describe("a window that may not list namespaces", () => {
  /**
   * "All namespaces" is a wall of 403s for this token. Fails if the window
   * stays there when the reader has used a namespace on this cluster before.
   */
  it("moves to the last namespace used instead of the whole cluster", () => {
    useNamespaceRecencyStore.setState({ recent: { dev: ["team-checkout"] } });
    renderHook(() => useRefusedScope());
    expect(scope()).toEqual(["team-checkout"]);
  });

  /** Fails if a window with nothing to fall back to is left without asking. */
  it("asks for a namespace when it can name none", () => {
    const opened = vi.fn();
    window.addEventListener(SCOPE_PICKER_OPEN, opened);
    renderHook(() => useRefusedScope());
    window.removeEventListener(SCOPE_PICKER_OPEN, opened);
    expect(opened).toHaveBeenCalledOnce();
    expect(scope()).toEqual([]);
  });

  /** A list that answered is the reader's to scope as they like. */
  it("leaves the whole cluster alone when the list was read", () => {
    list.state = "listed";
    useNamespaceRecencyStore.setState({ recent: { dev: ["team-checkout"] } });
    renderHook(() => useRefusedScope());
    expect(scope()).toEqual([]);
  });
});
