import { describe, expect, it } from "vitest";

import type { PodInfo } from "@/generated/types";
import { parseManifestYaml, podResource } from "./utils";

const pod = (status: Partial<PodInfo["status"]>): PodInfo =>
  ({
    name: "api-7d9f",
    namespace: "shop",
    labels: { app: "api" },
    containers: [{ image: "shop/api:1.4", ports: [{ containerPort: 8080 }] }],
    status: { phase: "Running", display: "Running", ready: true, ...status },
  }) as unknown as PodInfo;

describe("a live pod on the builder canvas", () => {
  /**
   * The complaint: a pod crash-looping for an hour was drawn as "Running",
   * because the canvas read `.status.phase` and the phase of such a pod is
   * Running. The word on the node has to be the one the Pods list shows.
   */
  it("carries the status kubectl prints, not the phase behind it", () => {
    const looping = podResource(
      pod({ phase: "Running", display: "CrashLoopBackOff", ready: false })
    );
    expect(looping.status).toBe("CrashLoopBackOff");
    expect(podResource(pod({})).status).toBe("Running");
  });

  /**
   * The mapping moved out of the hook to be testable; the rest of the node
   * has to come out exactly as the hook used to build it, or the canvas
   * draws imported pods without an image or with no ports to wire.
   */
  it("keeps the first container's image and ports", () => {
    const node = podResource(pod({}));
    expect(node.kind).toBe("Pod");
    expect(node.name).toBe("api-7d9f");
    expect(node.namespace).toBe("shop");
    expect(node.labels).toEqual({ app: "api" });
    expect(node.image).toBe("shop/api:1.4");
    expect(node.ports).toEqual([8080]);
    expect(node.origin).toBe("cluster");

    const bare = podResource({
      ...pod({}),
      containers: [],
      labels: undefined,
    } as unknown as PodInfo);
    expect(bare.image).toBe("nginx:latest");
    expect(bare.ports).toEqual([]);
    expect(bare.labels).toEqual({});
  });
});

describe("a pod pasted as a manifest", () => {
  const manifest = (status: string) => `
apiVersion: v1
kind: Pod
metadata:
  name: api-7d9f
  namespace: shop
spec:
  containers:
    - name: api
      image: shop/api:1.4
${status}`;

  /**
   * The same lie through the other door: `kubectl get pod -o yaml` of a
   * crash-looping pod says `phase: Running`, and the canvas used to print
   * exactly that. A live pod gets kubectl's derivation from Rust; a pasted
   * one has to get at least its first rule here.
   */
  it("reads a container's waiting reason over the phase", () => {
    const parsed = parseManifestYaml(
      manifest(`status:
  phase: Running
  containerStatuses:
    - name: api
      ready: false
      state:
        waiting:
          reason: CrashLoopBackOff`)
    );
    expect(parsed.resources[0]?.status).toBe("CrashLoopBackOff");
  });

  /**
   * The kubelet's `PodInitializing` is a placeholder, not a verdict: kubectl
   * prints the init progress there, and the phase is the nearest honest word
   * for a canvas that does not read init containers.
   */
  it("falls back to the phase when no container says otherwise", () => {
    const parsed = parseManifestYaml(
      manifest(`status:
  phase: Succeeded
  containerStatuses:
    - name: api
      state:
        running: {}`)
    );
    expect(parsed.resources[0]?.status).toBe("Succeeded");
    const initialising = parseManifestYaml(
      manifest(`status:
  phase: Pending
  containerStatuses:
    - name: api
      state:
        waiting:
          reason: PodInitializing`)
    );
    expect(initialising.resources[0]?.status).toBe("Pending");
    // A resource with no status, not no resource: the two read the same
    // through `resources[0]?.status`.
    const bare = parseManifestYaml(manifest(""));
    expect(bare.resources).toHaveLength(1);
    expect(bare.resources[0]?.status).toBeUndefined();
  });

  /**
   * kubectl prints `ExitCode:1` for a container that died without a reason,
   * and the lowest container's verdict wins over a later one's, the way
   * kubectl overwrites as it walks backwards.
   */
  it("prints the exit code or signal of a container that died without a reason", () => {
    const exited = parseManifestYaml(
      manifest(`status:
  phase: Running
  containerStatuses:
    - name: api
      state:
        terminated:
          exitCode: 1
    - name: proxy
      state:
        waiting:
          reason: CrashLoopBackOff`)
    );
    expect(exited.resources[0]?.status).toBe("ExitCode:1");
    const killed = parseManifestYaml(
      manifest(`status:
  phase: Running
  containerStatuses:
    - name: api
      state:
        terminated:
          exitCode: 137
          signal: 9`)
    );
    expect(killed.resources[0]?.status).toBe("Signal:9");
  });
});
