import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    focusCluster: vi.fn(async () => null),
    releaseClusters: vi.fn(async () => []),
    connectionAttempt: vi.fn(async () => null),
    saveClusterPreferences: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => [{ name: "dev" }, { name: "prod" }]),
    getCurrentContext: vi.fn(async () => "dev"),
    getClusterPreferences: vi.fn(async () => ({
      lastContext: "prod",
      namespaces: {},
      scopes: {},
    })),
  },
}));

import { commands } from "@/lib/commands";
import {
  credentialsExpired,
  credentialsRestored,
  readExpiredCredentials,
} from "@/lib/credentials";
import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import type { ClusterInfo, ContextInfo } from "@/generated/types";
import { hasSession, useClusterStore, wayBackTo } from "./clusterStore";
import { holdClusters } from "./heldClusters";
import { useClusterRecencyStore } from "./clusterRecencyStore";

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
   * Would take the ceiling off what a scope makes more expensive: the
   * overview reads every selected namespace every ten seconds, the events
   * feed asks each one every second, and this is the one place that number
   * is bounded.
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

  /** After a disconnect there is no current context, and the scope left
   *  behind belonged to the last cluster: connecting elsewhere kept it, and
   *  the new cluster opened filtered to a namespace it does not have. */
  it("does not carry the last cluster's scope across a disconnect", async () => {
    useClusterStore.setState({
      savedScopes: { "prod-eu": ["web"] },
      currentContext: null,
      namespaceScope: ["web"],
      currentNamespace: "web",
    });

    await state().connect("staging");

    expect(state().namespaceScope).toEqual([]);
  });

  /**
   * A Role that reads one namespace cannot read "All namespaces", and the
   * kubeconfig already says which one it is. Fails if a cluster with nothing
   * stored stops opening on its context's namespace.
   */
  it("opens a cluster on its kubeconfig namespace when nothing is stored", async () => {
    useClusterStore.setState({
      contexts: [
        { name: "marco", namespace: "team-checkout" },
      ] as unknown as ContextInfo[],
      savedScopes: {},
      currentContext: null,
      namespaceScope: [],
    });

    await state().connect("marco");

    expect(state().namespaceScope).toEqual(["team-checkout"]);
    expect(state().currentNamespace).toBe("team-checkout");
  });

  /** Fails if the kubeconfig overrules a scope the reader chose there. */
  it("keeps a stored choice over the kubeconfig namespace", async () => {
    useClusterStore.setState({
      contexts: [
        { name: "marco", namespace: "team-checkout" },
      ] as unknown as ContextInfo[],
      savedScopes: { marco: [] },
      currentContext: null,
      namespaceScope: [],
    });

    await state().connect("marco");

    expect(state().namespaceScope).toEqual([]);
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

describe("a connect that failed", () => {
  /**
   * The field is read by the cluster door, its toast and the alert panel.
   * Kept with the command in front, two of them printed
   * "Tauri command 'connectCluster' failed:" over the server's words.
   */
  it("keeps the server's words without the command in front", async () => {
    vi.mocked(commands.connectCluster).mockRejectedValueOnce(
      new Error(
        "Tauri command 'connectCluster' failed: exec plugin: aws-iam-authenticator not found"
      )
    );
    await state().connect("prod-eu");
    expect(state().error).toBe("exec plugin: aws-iam-authenticator not found");
  });

  /** The same field, set by an unreadable kubeconfig. */
  it("keeps the server's words when the contexts could not be read", async () => {
    vi.mocked(commands.listContexts).mockRejectedValueOnce(
      new Error("Tauri command 'listContexts' failed: kubeconfig: bad yaml")
    );
    await state().loadContexts();
    expect(state().error).toBe("kubeconfig: bad yaml");
  });
});

describe("restoring the last cluster on launch", () => {
  beforeEach(() => {
    vi.mocked(commands.connectCluster).mockClear();
    useClusterStore.setState({
      currentContext: null,
      connectionAttemptId: 0,
      pendingContext: null,
      isAuthenticating: false,
    });
  });

  /**
   * The address is the only thing that connects. A store that still
   * connected on launch would race the cluster the address names, and a
   * deep link would open under the saved cluster's name.
   */
  it("remembers the saved cluster for the front door and connects to nothing", async () => {
    await state().loadContexts();
    expect(state().lastContext).toBe("prod");
    expect(state().contextsKnown).toBe(true);
    expect(vi.mocked(commands.connectCluster)).not.toHaveBeenCalled();
  });

  /**
   * An unreadable kubeconfig is not one that lists nothing: the cluster
   * route says "could not read", never "not in your kubeconfig".
   */
  it("does not call the contexts known when they could not be read", async () => {
    useClusterStore.setState({ contextsKnown: false });
    vi.mocked(commands.listContexts).mockRejectedValueOnce(
      new Error("Tauri command 'listContexts' failed: kubeconfig: bad yaml")
    );
    await state().loadContexts();
    expect(state().contextsKnown).toBe(false);
  });

  /** Leaving a cluster on purpose must not bounce the front door straight back to it. */
  it("forgets the last cluster on a deliberate disconnect", async () => {
    await state().loadContexts();
    await state().disconnect();
    expect(state().lastContext).toBeNull();
  });
});

describe("landing on a different cluster", () => {
  /**
   * The counter is what tells a surface holding a route from the old cluster
   * to let go, so it has to move on exactly the connects that make a route
   * meaningless — and on no others, or every reconnect would throw the
   * reader off the page they were reading.
   */
  it("counts a move to another cluster and not a reconnect to the same one", async () => {
    useClusterStore.setState({
      lastConnected: null,
      contextSwitches: 0,
      currentContext: null,
    });

    await state().connect("dev");
    expect(state().contextSwitches).toBe(0);

    await state().connect("dev");
    expect(state().contextSwitches).toBe(0);

    await state().connect("prod");
    expect(state().contextSwitches).toBe(1);
  });

  /** Disconnecting does not make the next cluster the first one. */
  it("still counts the move when the window was disconnected in between", async () => {
    useClusterStore.setState({
      lastConnected: null,
      contextSwitches: 0,
      currentContext: null,
    });

    await state().connect("dev");
    await state().disconnect();
    await state().connect("prod");

    expect(state().contextSwitches).toBe(1);
  });

  /**
   * A deep link names the cluster and the object together, and arrives by
   * connecting and then navigating. Counting that as a switch would have the
   * tab let go of the very route the link is opening.
   */
  it("does not count a connect that is bringing its own route", async () => {
    useClusterStore.setState({
      lastConnected: null,
      contextSwitches: 0,
      currentContext: null,
    });
    await state().connect("dev");
    await state().connect("prod", { keepRoute: true });

    expect(state().contextSwitches).toBe(0);
  });

  /** A connect that failed left the reader where they were. */
  it("does not count a connect that never landed", async () => {
    useClusterStore.setState({
      lastConnected: null,
      contextSwitches: 0,
      currentContext: null,
    });
    await state().connect("dev");

    vi.mocked(commands.connectCluster).mockRejectedValueOnce(
      new Error("no route to host")
    );
    await state().connect("prod");

    expect(state().contextSwitches).toBe(0);
  });
});

interface Gate {
  promise: Promise<void>;
  open: () => void;
  fail: (error: Error) => void;
}

function gate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/**
 * The backend as the store sees it: which contexts hold a session, and which
 * one every read goes to. A connect lets go of its own context's session at
 * once and holds one only once it lands; a release never takes the current.
 */
function fakeBackend() {
  const live = new Set<string>();
  const gates = new Map<string, Gate>();
  let current: string | null = null;
  vi.mocked(commands.connectCluster).mockImplementation(async (context) => {
    current = context;
    live.delete(context);
    await gates.get(context)?.promise;
    live.add(context);
    return { context } as ClusterInfo;
  });
  vi.mocked(commands.focusCluster).mockImplementation(async (context) => {
    current = context;
    return context !== null && live.has(context)
      ? ({ context } as ClusterInfo)
      : null;
  });
  vi.mocked(commands.disconnectCluster).mockImplementation(async (context) => {
    live.delete(context);
    if (current === context) current = null;
  });
  vi.mocked(commands.releaseClusters).mockImplementation(async (keep) => {
    for (const name of [...live])
      if (!keep.includes(name) && name !== current) live.delete(name);
    return [...live].sort();
  });
  vi.mocked(commands.connectionAttempt).mockImplementation(async (context) => ({
    context,
    at: "2026-10-12T01:32:06Z",
    direct: {
      state: "failed",
      error: "deadline has elapsed",
      failure: "timeout",
    },
    proxy: { state: "notTried" },
  }));
  return {
    live,
    hold: (context: string) => {
      const held = gate();
      gates.set(context, held);
      return held;
    },
  };
}

/** Lets every pending promise, and the ones they start, settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("switching clusters keeps the one left until the new one lands", () => {
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(async () => {
    vi.clearAllMocks();
    holdClusters(() => []);
    useClusterStore.setState({
      currentContext: null,
      isConnected: false,
      pendingContext: null,
      isAuthenticating: false,
      error: null,
      errorContext: null,
      live: [],
      wayBack: null,
      failures: {},
      lastConnected: null,
    });
    backend = fakeBackend();
    await state().connect("acme-staging");
    await settle();
    vi.clearAllMocks();
  });

  afterEach(() => {
    holdClusters(() => []);
    vi.mocked(commands.connectCluster).mockImplementation(
      async (context) => ({ context }) as ClusterInfo
    );
    vi.mocked(commands.focusCluster).mockImplementation(async () => null);
    vi.mocked(commands.disconnectCluster).mockImplementation(
      async () => undefined
    );
    vi.mocked(commands.releaseClusters).mockImplementation(async () => []);
    vi.mocked(commands.connectionAttempt).mockImplementation(async () => null);
  });

  /**
   * Live round 23: Dana on acme-staging tried acme-prod-eu, which is
   * unreachable, and was left with no live cluster at all. Fails if the
   * switch lets go of the cluster it is leaving before the new one answers.
   */
  it("leaves the previous cluster live, current in Settings and a way back, when the switch fails", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");
    prod.fail(new Error("client error (Connect): deadline has elapsed"));
    await switching;
    await settle();

    expect(commands.disconnectCluster).not.toHaveBeenCalledWith("acme-staging");
    expect([...backend.live]).toEqual(["acme-staging"]);
    expect(state().live).toEqual(["acme-staging"]);
    expect(wayBackTo(state())).toBe("acme-staging");
    expect(state().errorContext).toBe("acme-prod-eu");
  });

  /**
   * Going back must show the cluster's screens at once. Fails if it
   * reconnects, or passes through the connecting state on the way.
   */
  it("goes back to the cluster it kept without connecting or a connecting pause", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");
    prod.fail(new Error("deadline has elapsed"));
    await switching;
    await settle();
    vi.mocked(commands.connectCluster).mockClear();

    let connecting = false;
    const stop = useClusterStore.subscribe((s) => {
      if (s.isAuthenticating) connecting = true;
    });
    await state().connect("acme-staging", { keepRoute: true });
    stop();

    expect(commands.focusCluster).toHaveBeenCalledWith("acme-staging");
    expect(commands.connectCluster).not.toHaveBeenCalled();
    expect(connecting).toBe(false);
    expect(state().isConnected).toBe(true);
    expect(state().currentContext).toBe("acme-staging");
  });

  /**
   * Live round 25: Back to acme-staging read "not connected" for 0.4 to
   * 3.4 s while the backend turned to it. Fails if any state on the way back
   * says the kept cluster has no session.
   */
  it("says a kept cluster is connected at every step of the way back", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");
    prod.fail(new Error("deadline has elapsed"));
    await switching;
    await settle();

    const said: boolean[] = [];
    const stop = useClusterStore.subscribe((s) => said.push(hasSession(s)));
    await state().connect("acme-staging", { keepRoute: true });
    stop();

    expect(said.length).toBeGreaterThan(1);
    expect(said).not.toContain(false);
  });

  /** Fails if a session through kubectl reads as the ordinary path while it comes back. */
  it("keeps naming the proxy while a cluster reached through it comes back", async () => {
    holdClusters(() => ["acme-staging", "acme-dev"]);
    vi.mocked(commands.connectCluster).mockImplementationOnce(
      async (context) => {
        backend.live.add(context);
        return { context, connected_through: "kubectl_proxy" } as ClusterInfo;
      }
    );
    await state().connect("acme-dev");
    await state().connect("acme-staging");
    await settle();

    const said: (string | null)[] = [];
    const stop = useClusterStore.subscribe((s) => {
      if (s.currentContext === "acme-dev") said.push(s.connectedThrough);
    });
    vi.mocked(commands.focusCluster).mockImplementationOnce(
      async (context) =>
        ({ context, connected_through: "kubectl_proxy" }) as ClusterInfo
    );
    await state().connect("acme-dev");
    stop();

    expect(said.length).toBeGreaterThan(1);
    expect(new Set(said)).toEqual(new Set(["kubectl_proxy"]));
  });

  /** Fails if a switch that landed leaves the cluster it left connected. */
  it("disconnects the previous cluster once the switch lands", async () => {
    await state().connect("acme-dev");
    await settle();

    expect([...backend.live]).toEqual(["acme-dev"]);
    expect(state().live).toEqual(["acme-dev"]);
    expect(state().wayBack).toBeNull();
  });

  /**
   * Scope tabs on two clusters: switching between them must not reconnect,
   * and a switch in one tab must not tear down the cluster another shows.
   * Fails if the parked tab's cluster is let go of after a landing.
   */
  it("keeps a cluster another tab shows, and comes back to it without connecting", async () => {
    holdClusters(() => ["acme-staging"]);
    await state().connect("acme-dev");
    await settle();
    expect([...backend.live].sort()).toEqual(["acme-dev", "acme-staging"]);

    holdClusters(() => ["acme-dev"]);
    vi.mocked(commands.connectCluster).mockClear();
    await state().connect("acme-staging");
    await settle();

    expect(commands.connectCluster).not.toHaveBeenCalled();
    expect(state().isConnected).toBe(true);
    expect(state().live).toEqual(["acme-dev", "acme-staging"]);
  });

  /**
   * A backend that let the session go answers a focus with nothing; the
   * window connects instead of claiming a cluster it does not hold.
   */
  it("connects after all when the backend no longer holds the cluster", async () => {
    useClusterStore.setState({ live: ["acme-staging", "acme-gone"] });

    await state().connect("acme-gone");

    expect(commands.focusCluster).toHaveBeenCalledWith("acme-gone");
    expect(commands.connectCluster).toHaveBeenCalledWith("acme-gone");
    expect(state().isConnected).toBe(true);
  });

  /**
   * Two switches in a row: the second wins, the first's sign-in is closed,
   * and the one that landed late is not left connected for nothing. Fails if
   * the abandoned attempt is not cancelled or its session outlives it.
   */
  it("lets the last of two quick switches win and leaves no session nothing uses", async () => {
    const prod = backend.hold("acme-prod-eu");
    const dev = backend.hold("acme-dev");
    const first = state().connect("acme-prod-eu");
    const second = state().connect("acme-dev");

    expect(commands.disconnectCluster).toHaveBeenCalledWith("acme-prod-eu");

    prod.open();
    await first;
    await settle();
    expect(state().pendingContext).toBe("acme-dev");
    expect([...backend.live]).toEqual(["acme-staging"]);

    dev.open();
    await second;
    await settle();
    expect(state().currentContext).toBe("acme-dev");
    expect([...backend.live]).toEqual(["acme-dev"]);
  });

  /**
   * A disconnect while a switch is still connecting is the last word: the
   * switch never lands on screen, and neither cluster keeps a session.
   */
  it("ends a disconnect issued mid-switch with nothing connected", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");

    await state().disconnect();
    expect(commands.disconnectCluster).toHaveBeenCalledWith("acme-prod-eu");
    expect(commands.focusCluster).toHaveBeenCalledWith(null);

    prod.open();
    await switching;
    await settle();

    expect(state().isConnected).toBe(false);
    expect(state().currentContext).toBeNull();
    expect([...backend.live]).toEqual([]);
  });

  /**
   * Live round 24: a new tab on acme-prod-eu re-applied its namespace after
   * the connect failed, and that wiped the error, so Settings and the front
   * door said "not connected" with no reason anywhere. Fails if a scope
   * change clears the failure, or if moving on loses it.
   */
  it("keeps a failed connect, with its kind and words, past a scope change and a move elsewhere", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");
    prod.fail(new Error("client error (Connect): deadline has elapsed"));
    await switching;

    await state().setNamespaceScope(["team-checkout"]);
    expect(state().errorContext).toBe("acme-prod-eu");

    await state().connect("acme-staging");
    expect(state().failures["acme-prod-eu"]).toEqual({
      kind: "timeout",
      error: "client error (Connect): deadline has elapsed",
    });
  });

  /** Fails if one context's failure overwrites another's. */
  it("keeps each context's failure apart", async () => {
    const prod = backend.hold("acme-prod-eu");
    const first = state().connect("acme-prod-eu");
    prod.fail(new Error("deadline has elapsed"));
    await first;
    const dr = backend.hold("acme-dr");
    const second = state().connect("acme-dr");
    dr.fail(new Error("connection refused"));
    await second;

    expect(Object.keys(state().failures).sort()).toEqual([
      "acme-dr",
      "acme-prod-eu",
    ]);
  });

  /** Fails if a context that lands keeps reading as failed. */
  it("forgets a failure once that context lands", async () => {
    const prod = backend.hold("acme-prod-eu");
    const switching = state().connect("acme-prod-eu");
    prod.fail(new Error("deadline has elapsed"));
    await switching;

    prod.open();
    backend.hold("acme-prod-eu").open();
    await state().connect("acme-prod-eu");

    expect(state().failures).toEqual({});
  });

  /**
   * The front door said acme-staging was last used 15 minutes ago, seconds
   * after it was on screen: the time was the connect's. Fails if leaving a
   * cluster does not count as its last use.
   */
  it("counts leaving a cluster as its last use", async () => {
    useClusterRecencyStore.setState({ lastUsed: { "acme-staging": 1 } });

    await state().connect("acme-dev");

    expect(
      useClusterRecencyStore.getState().lastUsed["acme-staging"]
    ).toBeGreaterThan(1);
  });
});
