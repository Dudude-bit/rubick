import { describe, expect, it } from "vitest";

import type { LogScope } from "../registry";
import { escapeLabel, LOKI_LABELS, streamSelector } from "./queries";

const pod = (namespace: string, name: string): LogScope => ({
  kind: "pod",
  namespace,
  pod: name,
});

const workload = (
  namespace: string,
  owner: string,
  ownerKind: string
): LogScope => ({ kind: "workload", namespace, owner, ownerKind });

describe("the stream selector", () => {
  it("asks for one pod by name", () => {
    expect(streamSelector(pod("k8s-gui-test", "log-demo-7f9-abc"))).toBe(
      '{namespace="k8s-gui-test",pod="log-demo-7f9-abc"}'
    );
  });

  /**
   * Would break if a range stopped spanning rollouts.
   *
   * The hash in `<name>-<replicaset>-<suffix>` changes on every deploy, so a
   * selector built from the *current* ReplicaSet would answer only for the
   * generation the API server can still be asked about — and the generation
   * that crashed twenty minutes ago, which is the one somebody opened this
   * range to read, would be missing with nothing on screen saying so.
   */
  it("spans every generation a Deployment has had", () => {
    expect(streamSelector(workload("demo", "log-demo", "Deployment"))).toBe(
      '{namespace="demo",pod=~"^log-demo-[^-]+-[^-]+$"}'
    );
  });

  it("matches a StatefulSet by its stable ordinal", () => {
    expect(streamSelector(workload("demo", "db", "StatefulSet"))).toBe(
      '{namespace="demo",pod=~"^db-[0-9]+$"}'
    );
  });

  it("matches a DaemonSet's single suffix", () => {
    expect(streamSelector(workload("demo", "agent", "DaemonSet"))).toBe(
      '{namespace="demo",pod=~"^agent-[^-]+$"}'
    );
  });

  /**
   * Would break if a workload started claiming another workload's pods.
   *
   * `foo-bar-<hash>-<suffix>` has three segments after `foo-` and the pattern
   * admits exactly two, so `foo` cannot swallow `foo-bar`'s log — which on a
   * log pane would be worse than on a chart, because the lines would be
   * indistinguishable from the ones the reader came for.
   */
  it("does not let one workload claim a longer-named one's pods", () => {
    const selector = streamSelector(workload("demo", "api", "Deployment"));
    const pattern = new RegExp(/pod=~"([^"]+)"/.exec(selector)![1]);

    expect(pattern.test("api-6f7d9c-2xk4l")).toBe(true);
    expect(pattern.test("api-gateway-6f7d9c-2xk4l")).toBe(false);
    expect(pattern.test("apiserver-6f7d9c-2xk4l")).toBe(false);

    // The one collision that is left, stated rather than pretended away: a
    // bare Pod a human named with two extra segments matches. It is not
    // worth an API call to rule out, and on a log it is visible anyway —
    // every line carries the pod that wrote it.
    expect(pattern.test("api-written-byhand")).toBe(true);
  });

  /**
   * Would break if a name with a dot in it started matching its neighbours.
   * Kubernetes names are DNS-1123, so `.` is the one character in them that
   * means something to RE2.
   */
  it("escapes a name that would otherwise be a pattern", () => {
    const selector = streamSelector(workload("demo", "a.b", "DaemonSet"));
    expect(selector).toContain("^a\\\\.b-");
    const pattern = new RegExp(
      /pod=~"(.+)"\}/.exec(selector)![1].replace(/\\\\/g, "\\")
    );
    expect(pattern.test("a.b-xyz")).toBe(true);
    expect(pattern.test("axb-xyz")).toBe(false);
  });

  /** Would break if a namespace could end the matcher early and inject one. */
  it("escapes the two characters that would end a label value", () => {
    expect(escapeLabel('ns"evil')).toBe('ns\\"evil');
    expect(escapeLabel("ns\\evil")).toBe("ns\\\\evil");
    expect(streamSelector(pod('a"b', "p"))).toBe('{namespace="a\\"b",pod="p"}');
  });
});

describe("the labels a mismatch is reported against", () => {
  /**
   * Would break if the sentence a zero-stream answer prints started naming a
   * label the query never used. `container` is read off the streams that come
   * back but is never selected on, so an install that dropped it is not the
   * reason anybody got nothing — and sending a reader to check it would cost
   * them the afternoon.
   */
  it("names exactly what the selector asked for", () => {
    expect([...LOKI_LABELS]).toEqual(["namespace", "pod"]);
    for (const label of LOKI_LABELS) {
      expect(streamSelector(pod("demo", "p"))).toContain(`${label}=`);
    }
    expect(streamSelector(pod("demo", "p"))).not.toContain("container");
  });
});
