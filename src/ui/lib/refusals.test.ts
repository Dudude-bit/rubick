import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { listPodRows } from "@/lib/pod-rows";
import { setTransport, transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { useClusterStore } from "@/stores/clusterStore";

const REFUSED = {
  code: "PERMISSION_DENIED",
  message:
    'daemonsets.apps is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "daemonsets" in API group "apps" in the namespace "team-checkout"',
};

const asked: string[] = [];
let answer: () => unknown = () => {
  throw REFUSED;
};
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
  list_pod_rows: () => {
    asked.push("pods");
    return "pods-1";
  },
  pod_rows_subscribed: () => {
    queueMicrotask(() =>
      fake.emit({
        channel: "pod-rows-failed",
        stream_id: "pods-1",
        message:
          'Kubernetes API error: ApiError: pods is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "pods" at the cluster scope',
      })
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
  reconnect();
});

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
