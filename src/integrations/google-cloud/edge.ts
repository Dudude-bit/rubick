/**
 * The `BackendConfig`s attached to one Service, for the traffic chain.
 *
 * The link runs the awkward way round: the Service names the config, in a
 * JSON annotation, and the config names nothing. So this reads the Service
 * first and then looks for what it asked for — which is also why a dangling
 * reference is worth reporting. A Service annotated with the name of a
 * `BackendConfig` that does not exist is a real and quiet failure: GKE logs
 * an event on the Ingress and applies no configuration at all, so the backend
 * silently keeps the defaults the reader thought they had overridden.
 *
 * **That missing object is the only problem this file will ever report.** A
 * `BackendConfig` states no status — the upstream type is declared with none
 * and its CRD carries an empty status object — so there is no such thing as a
 * `BackendConfig` that says its health check is failing. Whether Google's
 * load balancer is actually failing that check is a question for the cloud's
 * API, one tier up, and asserting it from anything in this cluster would be
 * a guess wearing a verdict's clothes.
 */

import { commands } from "@/lib/commands";

import { crdObjectPath } from "../kit";
import type { EdgeConfig } from "../registry";
import {
  BACKEND_CONFIG_CRD,
  backendConfigRefs,
  backendConfigSummary,
} from "./model";

export async function serviceEdge({
  namespace,
  name,
}: {
  namespace: string;
  name: string;
}): Promise<EdgeConfig[]> {
  const service = await commands.getService(name, namespace);
  const refs = backendConfigRefs(service.annotations);
  // The overwhelmingly common case, and it costs one read: a Service with no
  // annotation names no config, so the list page is never asked for.
  if (refs.length === 0) return [];

  const configs = await commands.listCustomResources(
    BACKEND_CONFIG_CRD,
    namespace,
    null,
    null
  );

  return refs.map((ref): EdgeConfig => {
    const scope = ref.port === null ? "every port" : `port ${ref.port}`;
    const found = configs.find((config) => config.name === ref.name);
    if (!found) {
      return {
        source: { kind: "BackendConfig", name: ref.name, to: "" },
        summary: `named for ${scope}`,
        problem: {
          text: `no BackendConfig named ${ref.name} in this namespace — nothing is applied`,
          tone: "err",
        },
      };
    }
    return {
      source: {
        kind: "BackendConfig",
        name: ref.name,
        to: crdObjectPath(BACKEND_CONFIG_CRD, namespace, ref.name),
      },
      summary: `${scope} · ${backendConfigSummary(found)}`,
      problem: null,
    };
  });
}
