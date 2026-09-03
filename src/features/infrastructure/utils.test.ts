import { describe, expect, it } from "vitest";

import type { PodInfo } from "@/generated/types";
import { loadAll } from "js-yaml";

import type { Manifest } from "./types";
import { buildManifestYaml, parseManifestYaml, podResource } from "./utils";

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

const PASTED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
  annotations:
    team: checkout
  labels:
    app: api
spec:
  replicas: "3"
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: shop/api:1.4
          ports:
            - containerPort: "8080"
        - name: sidecar
          image: envoy:1.30
          env:
            - name: MODE
              value: sidecar
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: shop
spec:
  type: NodePort
  selector:
    app: api
    tier: 2
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Secret
metadata:
  name: tls
type: kubernetes.io/tls
data:
  tls.crt: abc
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
`;

const docs = (yaml: string): Manifest[] => {
  const out: Manifest[] = [];
  loadAll(yaml, (doc) => out.push(doc as Manifest));
  return out;
};

describe("a pasted manifest round-trips through the canvas", () => {
  /**
   * The builder reads six fields and writes six fields; everything else in
   * a pasted document has to come back out untouched, or a paste-and-export
   * silently strips the annotation somebody's controller keys on.
   */
  it("keeps what it does not read", () => {
    const parsed = parseManifestYaml(PASTED);
    expect(parsed.errors).toEqual([]);
    expect(parsed.resources.map((r) => r.kind)).toEqual([
      "Deployment",
      "Service",
      "Secret",
    ]);
    expect(parsed.extraManifests).toHaveLength(1);

    const [deployment, service, secret, account] = docs(
      buildManifestYaml(parsed.resources, parsed.extraManifests)
    );
    expect(deployment?.metadata?.annotations).toEqual({ team: "checkout" });
    expect(deployment?.spec?.strategy).toEqual({ type: "Recreate" });
    expect(deployment?.spec?.template?.spec?.containers?.[1]).toMatchObject({
      name: "sidecar",
      env: [{ name: "MODE", value: "sidecar" }],
    });
    expect(service?.spec?.type).toBe("NodePort");
    expect(secret?.type).toBe("kubernetes.io/tls");
    expect(account?.kind).toBe("ServiceAccount");
  });

  /** YAML quotes numbers as easily as not; the canvas counts either way. */
  it("reads a quoted number as a number", () => {
    const [deployment, service] = parseManifestYaml(PASTED).resources;
    expect(deployment).toMatchObject({ replicas: 3, ports: [8080] });
    expect(service).toMatchObject({
      ports: [80],
      selectors: { app: "api", tier: "2" },
    });
  });

  /**
   * An edit on the canvas is written over the pasted document: the first
   * container takes the new image and loses its ports, the labels the reader
   * emptied are removed rather than left, and the selector follows them.
   */
  it("writes the canvas's edits back over the document", () => {
    const parsed = parseManifestYaml(PASTED);
    const deployment = parsed.resources[0];
    if (deployment?.kind !== "Deployment")
      throw new Error("expected a Deployment");
    const [built] = docs(
      buildManifestYaml(
        [{ ...deployment, image: "shop/api:2.0", ports: [], labels: {} }],
        []
      )
    );
    const [primary, sidecar] = built?.spec?.template?.spec?.containers ?? [];
    expect(primary).toEqual({ name: "api", image: "shop/api:2.0" });
    expect(sidecar?.image).toBe("envoy:1.30");
    expect(built?.metadata?.labels).toBeUndefined();
    expect(built?.spec?.selector?.matchLabels).toEqual({ app: "api" });
    expect(built?.spec?.template?.metadata?.labels).toEqual({ app: "api" });
  });
});
