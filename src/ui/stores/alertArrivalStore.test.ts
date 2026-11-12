import { expect, it } from "vite-plus/test";

import type { AlertReading } from "@/lib/alerts";
import { namesRebound } from "@/lib/kept-by-name";
import { useAlertArrivalStore } from "./alertArrivalStore";

/**
 * The banner is drawn on the object the alert was opened at, in the cluster
 * of that name. Fails if, after the kubeconfig files put another cluster
 * behind the name, the claim is still drawn on its namesake there.
 */
it("lets go of the alert when the kubeconfig files change under its cluster's name", () => {
  useAlertArrivalStore.getState().arrive({} as AlertReading, {
    context: "default",
    kind: "Deployment",
    name: "payments",
    namespace: "shop",
  });
  expect(useAlertArrivalStore.getState().at).not.toBeNull();

  namesRebound();

  expect(useAlertArrivalStore.getState()).toMatchObject({
    reading: null,
    at: null,
  });
});
