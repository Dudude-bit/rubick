import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vite-plus/test";

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
