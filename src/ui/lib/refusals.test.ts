import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { commands } from "@/lib/commands";
import { credentialsRenewed } from "@/lib/credentials";
import { isRefusal } from "@/lib/error-utils";
import { listPodRows } from "@/lib/pod-rows";
import { askAgainWhenLetGo, askedAgainFirst, KEPT_FOR } from "@/lib/refusals";
import { setTransport, transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { useClusterStore } from "@/stores/clusterStore";

const REFUSED = {
  code: "PERMISSION_DENIED",
  message:
    'daemonsets.apps is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "daemonsets" in API group "apps" in the namespace "team-checkout"',
};

const PODS_REFUSED = {
  code: "PERMISSION_DENIED",
  message:
    'Could not read the Pod list: pods is forbidden: User "jane@example.com" cannot list resource "pods" in API group "" at the cluster scope',
};

const asked: string[] = [];
let answer: () => unknown = () => {
  throw REFUSED;
};
let connections: () => unknown = () => {
  throw PODS_REFUSED;
};
let podsAnswer = false;
const real = transport();
const fake = fakeTransport({
  list_daemonsets_in: (args) => {
    asked.push(`daemonsets ${JSON.stringify(args?.scope)}`);
    return answer();
  },
  delete_pod: () => {
    asked.push("delete");
    throw REFUSED;
  },
  get_daemonset: () => {
    asked.push("daemonset");
    return {};
  },
  get_node: () => {
    asked.push("node");
    return {};
  },
  get_resource_connections: () => {
    asked.push("connections");
    return connections();
  },
  list_pod_rows: () => {
    asked.push("pods");
    return "pods-1";
  },
  pod_rows_subscribed: () => {
    queueMicrotask(() =>
      fake.emit(
        podsAnswer
          ? {
              channel: "pod-rows-done",
              stream_id: "pods-1",
              rows: 0,
              complete: true,
              elapsed_ms: 1,
              unread: [],
            }
          : {
              channel: "pod-rows-failed",
              stream_id: "pods-1",
              message:
                'Kubernetes API error: ApiError: pods is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "pods" at the cluster scope',
            }
      )
    );
  },
  stop_pod_rows: () => undefined,
});
setTransport(fake.transport);
afterAll(() => setTransport(real));

const reconnect = () =>
  useClusterStore.setState((s) => ({
    connectionAttemptId: s.connectionAttemptId + 1,
  }));

const refusedIn = (scope: string[] | null) =>
  commands.listDaemonsetsIn(scope).then(
    () => "answered",
    (error: unknown) => (isRefusal(error) ? "refused" : "failed")
  );

beforeEach(() => {
  asked.length = 0;
  answer = () => {
    throw REFUSED;
  };
  connections = () => {
    throw PODS_REFUSED;
  };
  podsAnswer = false;
  reconnect();
});

const pointedAt = () =>
  commands
    .getResourceConnections("Deployment", "api", "fulfillment", null, null)
    .then(
      () => "answered",
      (error: unknown) => (isRefusal(error) ? "refused" : "failed")
    );

describe("a read the cluster refused on this connection", () => {
  /**
   * Marco's DaemonSets page asked listDaemonsetsIn at +2, +2, +4, +8, +16 s
   * and was refused each time. Fails if a refused read reaches the cluster
   * a second time on the same connection.
   */
  it("is answered with the same refusal without asking again", async () => {
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(asked).toEqual(['daemonsets ["team-checkout"]']);
  });

  /** A refusal is about one question: the same command in another scope is another read. */
  it("still asks the same command about another scope", async () => {
    await refusedIn(["team-checkout"]);
    await refusedIn(null);
    expect(asked).toEqual(['daemonsets ["team-checkout"]', "daemonsets null"]);
  });

  /** A role granted mid-session reaches the reader on the next connect. Fails if the memory outlives it. */
  it("is asked again after a reconnect", async () => {
    await refusedIn(["team-checkout"]);
    reconnect();
    answer = () => ({ items: [], unread: [] });
    expect(await refusedIn(["team-checkout"])).toBe("answered");
    expect(asked).toHaveLength(2);
  });

  /**
   * An OIDC refresh that brought new groups kept the 403 the old ones got
   * until a reconnect. Fails if a renewal leaves a refusal standing.
   */
  it("is asked again after the credentials are renewed", async () => {
    await refusedIn(["team-checkout"]);
    credentialsRenewed();
    answer = () => ({ items: [], unread: [] });
    expect(await refusedIn(["team-checkout"])).toBe("answered");
    expect(asked).toHaveLength(2);
  });

  /** The old connection's verdict, arriving late, is not the new one's. */
  it("is not kept for a connection that began while it was asked", async () => {
    let refuse = () => {};
    answer = () =>
      new Promise((_, reject) => {
        refuse = () => reject(REFUSED);
      });
    const late = refusedIn(["team-checkout"]);
    await Promise.resolve();
    reconnect();
    refuse();
    expect(await late).toBe("refused");
    answer = () => ({ items: [], unread: [] });
    expect(await refusedIn(["team-checkout"])).toBe("answered");
  });

  /** A failure is not a verdict. Fails if a timeout or a 500 is remembered like a 403. */
  it("keeps asking a read that failed for another reason", async () => {
    answer = () => {
      throw { code: "TIMEOUT_ERROR", message: "the request timed out" };
    };
    expect(await refusedIn(["team-checkout"])).toBe("failed");
    expect(await refusedIn(["team-checkout"])).toBe("failed");
    expect(asked).toHaveLength(2);
  });

  /**
   * Marco came back to Namespaces and its refusal said "13m ago": the memory
   * answered the visit. Fails if a read asked again is answered from memory,
   * if its new refusal is not the one kept, or if the asks after it reach the
   * cluster.
   */
  it("asks the cluster again inside askAgain and keeps the new refusal for the asks after it", async () => {
    await refusedIn(["team-checkout"]);
    const first = askedAgainFirst();
    expect(await first(() => refusedIn(["team-checkout"]))).toBe("refused");
    expect(await first(() => refusedIn(["team-checkout"]))).toBe("refused");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(asked).toEqual([
      'daemonsets ["team-checkout"]',
      'daemonsets ["team-checkout"]',
    ]);
  });

  /** An action is the reader's to try again: a delete refused once is sent again when asked. */
  it("never answers an action from memory", async () => {
    await commands.deletePod("api", "team-checkout", null).catch(() => {});
    await commands.deletePod("api", "team-checkout", null).catch(() => {});
    expect(asked).toEqual(["delete", "delete"]);
  });
});

describe("a pod list refused as a stream", () => {
  /**
   * The refusal arrives as an event, past the command wrapper, and Marco's
   * Pods page under All namespaces asked again every two seconds. Fails if
   * the stream's refusal is not the memory's.
   */
  it("is not asked again on the same connection", async () => {
    await expect(listPodRows(null)).rejects.toThrow(/forbidden/);
    await expect(listPodRows(null)).rejects.toThrow(/forbidden/);
    expect(asked).toEqual(["pods"]);
  });
});

describe("a kept refusal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A transient 403 lived for the whole connection: fifteen minutes later the
   * status bar still named it. Fails if a refusal is answered from memory
   * once it has been kept KEPT_FOR, or if it is asked again before that.
   */
  it("is asked again once it has been kept for KEPT_FOR, and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    vi.setSystemTime(Date.now() + KEPT_FOR - 1000);
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1000);
    answer = () => ({ items: [], unread: [] });
    expect(await refusedIn(["team-checkout"])).toBe("answered");
    expect(asked).toHaveLength(2);
  });

  /**
   * The ingress-clients probe sat refused under a query nothing polls, so
   * letting go of the memory alone changed nothing on screen. Fails if a
   * query showing a refusal is not asked again when the refusal is let go.
   */
  it("asks the query showing it again when it is let go", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const stop = askAgainWhenLetGo(client);
    const observer = new QueryObserver(client, {
      queryKey: ["daemonsets", "team-checkout"],
      queryFn: () => commands.listDaemonsetsIn(["team-checkout"]),
      staleTime: Infinity,
    });
    const off = observer.subscribe(() => {});
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().status).toBe("error")
    );
    answer = () => ({ items: [], unread: [] });
    await vi.advanceTimersByTimeAsync(KEPT_FOR);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().status).toBe("success")
    );
    expect(asked).toHaveLength(2);
    off();
    stop();
    client.clear();
  });

  /**
   * Six minutes after the pods 403 cleared, the Delete dialog still said
   * "Could not check what points at it ... pods is forbidden" beside a live
   * Pods list. Fails if the Pods list answering leaves a refusal that names
   * pods standing.
   */
  it("is let go when a read of the resource it names answers", async () => {
    expect(await pointedAt()).toBe("refused");
    podsAnswer = true;
    await listPodRows(null);
    connections = () => ({ rows: [] });
    expect(await pointedAt()).toBe("answered");
    expect(asked).toEqual(["connections", "pods", "connections"]);
  });

  /** A stream's handshake is not its answer. Fails if a pod list that went on to be refused let the pods refusal go. */
  it("is kept when a pod list stream opens and is then refused", async () => {
    expect(await pointedAt()).toBe("refused");
    await expect(listPodRows(null)).rejects.toThrow(/forbidden/);
    expect(await pointedAt()).toBe("refused");
    expect(asked).toEqual(["connections", "pods"]);
  });

  /** Fails if any read answering lets every refusal go, rather than one of the resource refused. */
  it("is kept when a read of another resource answers", async () => {
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    await commands.getNode("node-1");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(asked).toEqual(['daemonsets ["team-checkout"]', "node"]);
  });

  /**
   * A role that reads DaemonSets by name but not as a list in team-checkout:
   * every poll of the one answering would let the other go, and it would be
   * one 403 per poll. Fails if a refusal let go by an answer and refused
   * again is let go by the next answer within KEPT_FOR.
   */
  it("is let go by an answer once, then kept for KEPT_FOR", async () => {
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    await commands.getDaemonset("fluent-bit", "team-checkout");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    await commands.getDaemonset("fluent-bit", "team-checkout");
    expect(await refusedIn(["team-checkout"])).toBe("refused");
    expect(asked).toEqual([
      'daemonsets ["team-checkout"]',
      "daemonset",
      'daemonsets ["team-checkout"]',
      "daemonset",
    ]);
  });
});
