import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vite-plus/test";

import { namesRebound } from "@/lib/kept-by-name";
import { useClusterStore } from "@/stores/clusterStore";
import {
  forgetLastOwners,
  useLastOwners,
  useRememberOwners,
} from "./useLastOwners";

const KNATIVE = {
  kind: "Service",
  name: "frontend",
  namespace: "storefront",
  crd: "services.serving.knative.dev",
};
const CORE = { kind: "Service", name: "frontend", namespace: "storefront" };
const owner = {
  apiVersion: "serving.knative.dev/v1",
  kind: "Route",
  name: "frontend",
  controller: true,
};

beforeEach(() => {
  forgetLastOwners();
  useClusterStore.setState({ currentContext: "test" });
});

/**
 * Knative's Service and the core Service it makes share a kind name, a
 * namespace and a name. Fails if the owners one's read named are given out
 * as the other's once it is gone.
 */
it("keeps a custom resource's owners apart from the built-in of its name", () => {
  renderHook(() => useRememberOwners(KNATIVE, { ownerReferences: [owner] }));
  expect(renderHook(() => useLastOwners(KNATIVE)).result.current).toEqual([
    owner,
  ]);
  expect(renderHook(() => useLastOwners(CORE)).result.current).toBeUndefined();
});

/**
 * The owners are kept under the context name, and after a kubeconfig change
 * that name can be another cluster. Fails if a pod gone there is said to
 * belong to the owner its namesake had in the cluster before.
 */
it("forgets them when the kubeconfig files change under the name", () => {
  renderHook(() => useRememberOwners(CORE, { ownerReferences: [owner] }));
  expect(renderHook(() => useLastOwners(CORE)).result.current).toEqual([owner]);

  namesRebound();

  expect(renderHook(() => useLastOwners(CORE)).result.current).toBeUndefined();
});

/**
 * A Service's read has no owner references in it; a pod's has an empty list
 * when nothing owns it, and a manifest leaves the field out. Only the last
 * two looked. Fails if a read that carries no owners is remembered as one
 * that found none, which the gone notice words as "Nothing owned it, so
 * nothing replaces it".
 */
it("tells a read that named no owners from one that never carries them", () => {
  const POD = { kind: "Pod", name: "bare", namespace: "storefront" };
  const MANIFEST = { kind: "Widget", name: "w", namespace: "storefront" };
  renderHook(() => useRememberOwners(CORE, { name: "frontend", ports: [] }));
  renderHook(() => useRememberOwners(POD, { ownerReferences: [] }));
  renderHook(() => useRememberOwners(MANIFEST, { metadata: { name: "w" } }));

  expect(renderHook(() => useLastOwners(CORE)).result.current).toBeNull();
  expect(renderHook(() => useLastOwners(POD)).result.current).toEqual([]);
  expect(renderHook(() => useLastOwners(MANIFEST)).result.current).toEqual([]);
});
