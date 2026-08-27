import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import {
  credentialsExpired,
  credentialsRestored,
  readExpiredCredentials,
} from "@/lib/credentials";
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

describe("moving between clusters", () => {
  /**
   * Reported from a shop with six clusters and rights to a couple of
   * namespaces in each: switching cleared the selection every time, so the
   * same two or three namespaces were picked again on every move.
   */
  it("restores what that cluster was last left on", async () => {
    useClusterStore.setState({
      savedScopes: { "prod-eu": ["web"], "prod-us": ["api", "jobs"] },
      currentContext: "prod-eu",
      namespaceScope: ["web"],
      currentNamespace: "web",
    });

    await state().switchContext("prod-us");

    expect(state().namespaceScope).toEqual(["api", "jobs"]);
    // Two namespaces have no single wire value; the selection is the truth.
    expect(state().currentNamespace).toBe("");
  });

  it("gives the whole cluster to one it has never been asked about", async () => {
    useClusterStore.setState({
      savedScopes: { "prod-eu": ["web"] },
      currentContext: "prod-eu",
      namespaceScope: ["web"],
      currentNamespace: "web",
    });

    await state().switchContext("staging");

    expect(state().namespaceScope).toEqual([]);
    expect(state().currentNamespace).toBe("");
  });

  /** Switching to the cluster already open changes nothing. */
  it("leaves the scope alone when the context has not moved", async () => {
    useClusterStore.setState({
      savedScopes: { "prod-eu": ["something", "else"] },
      currentContext: "prod-eu",
      namespaceScope: ["web", "api"],
      currentNamespace: "",
    });

    await state().switchContext("prod-eu");

    expect(state().namespaceScope).toEqual(["web", "api"]);
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
    expect(saveClusterPreferences).toHaveBeenCalledWith(null, "prod-eu", "", [
      "web",
      "api",
    ]);

    await state().setNamespaceScope(["web"]);
    expect(saveClusterPreferences).toHaveBeenLastCalledWith(
      null,
      "prod-eu",
      "web",
      ["web"]
    );
  });

  /**
   * The whole selection rides in its own field, so the wire value stays the
   * single namespace an older build knows how to ask for while this one
   * keeps all of it.
   */
  it("keeps the whole selection beside the one an older build reads", async () => {
    await state().setNamespaceScope(["web", "api", "jobs"]);
    const [, , wire, scope] = saveClusterPreferences.mock.lastCall!;
    expect(wire).toBe("");
    expect(scope).toEqual(["web", "api", "jobs"]);
  });

  it("writes nothing while no cluster owns the scope", async () => {
    useClusterStore.setState({ currentContext: null });
    await state().setNamespaceScope(["web"]);
    expect(saveClusterPreferences).not.toHaveBeenCalled();
  });
});

/**
 * The refusal flag is raised at the commands choke point; the only thing
 * that may lower it is a session the cluster actually accepted. "Sign in
 * again" reconnects to the *same* context, so clearing must ride on the
 * connect that worked — the context-change effect never fires for it, and
 * the reader was left staring at the banner over a healthy session.
 */
describe("an expired session and the reconnect", () => {
  beforeEach(() => credentialsRestored());

  it("clears the refusal when the same context connects again", async () => {
    credentialsExpired("Unauthorized");
    await state().connect("prod-eu");
    expect(readExpiredCredentials()).toBeNull();
    expect(state().isConnected).toBe(true);
  });

  it("keeps the refusal when the reconnect fails too", async () => {
    credentialsExpired("Unauthorized");
    vi.mocked(commands.connectCluster).mockRejectedValueOnce(
      new Error("still refused")
    );
    await state().connect("prod-eu");
    expect(readExpiredCredentials()).not.toBeNull();
    expect(state().isConnected).toBe(false);
  });
});
