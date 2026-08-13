import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import { useClusterStore } from "./clusterStore";

const saveClusterPreferences = vi.mocked(commands.saveClusterPreferences);

const state = () => useClusterStore.getState();

beforeEach(() => {
  saveClusterPreferences.mockClear();
  useClusterStore.setState({
    currentContext: "prod-eu",
    currentNamespace: "",
    namespaceScope: [],
  });
});

describe("what the window is scoped to", () => {
  it("derives the wire value from the selection", async () => {
    await state().setNamespaceScope(["web"]);
    expect(state().currentNamespace).toBe("web");

    // Several has no single namespace to ask for, so the lists read the
    // cluster and narrow afterwards.
    await state().setNamespaceScope(["web", "api"]);
    expect(state().currentNamespace).toBe("");
  });

  it("drops empties and duplicates rather than passing them on", async () => {
    await state().setNamespaceScope(["web", "", "web", "api"]);
    expect(state().namespaceScope).toEqual(["web", "api"]);
  });

  /**
   * Would take the ceiling off the only thing a scope makes more expensive:
   * the overview is one read per selected namespace every ten seconds, and
   * this is the one place that number is bounded.
   */
  it("never watches more namespaces than it can answer for", async () => {
    await state().setNamespaceScope(
      Array.from({ length: SCOPE_LIMIT + 4 }, (_, i) => `ns-${i}`)
    );
    expect(state().namespaceScope).toHaveLength(SCOPE_LIMIT);
    expect(state().namespaceScope[0]).toBe("ns-0");
  });
});

describe("what is written to disk", () => {
  /**
   * Would break every screen of a build that does not have this feature.
   * `ClusterPreferences.namespaces` is one string per context and older
   * builds read it straight into `currentNamespace`; handed `"web,api"` they
   * would ask for a namespace that does not exist and show nothing anywhere,
   * without ever saying why.
   */
  it("saves a namespace an older build can still ask for", async () => {
    await state().setNamespaceScope(["web", "api"]);
    expect(saveClusterPreferences).toHaveBeenCalledWith(null, "prod-eu", "");

    await state().setNamespaceScope(["web"]);
    expect(saveClusterPreferences).toHaveBeenLastCalledWith(
      null,
      "prod-eu",
      "web"
    );
  });

  it("writes nothing while no cluster owns the scope", async () => {
    useClusterStore.setState({ currentContext: null });
    await state().setNamespaceScope(["web"]);
    expect(saveClusterPreferences).not.toHaveBeenCalled();
  });
});
