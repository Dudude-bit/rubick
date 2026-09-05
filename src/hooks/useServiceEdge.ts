import { useQueries } from "@tanstack/react-query";

import { useCapabilities, type EdgeConfig } from "@/integrations";

export interface ServiceEdges {
  /**
   * Whether anything in this cluster can answer the question at all.
   *
   * `false` is the state nearly every reader is in — it needs one of the
   * managed clouds' controllers installed — and it is not an error: the chain
   * draws the Service hop it always draws.
   */
  available: boolean;
  /** `namespace/name` to what configures the way in. Absent means "not read
   *  yet"; present and empty means "read, and nothing configures it". */
  configs: Map<string, EdgeConfig[]>;
  /**
   * Set where a capability was there and did not answer. Dropping the failure
   * would tell the reader this Service has no cloud configuration, which is a
   * different and possibly wrong sentence.
   */
  error: Error | null;
}

export const edgeKey = (namespace: string, name: string) =>
  `${namespace}/${name}`;

/**
 * What the cloud's own objects say about the way into these Services.
 *
 * Asks for a capability, not for GKE or for the AWS load balancer controller:
 * this hook does not know what answered and neither does the chain it hands
 * the answer to.
 *
 * Every installed supplier is asked, not only the first — unlike
 * `certificate.issuance`, where one thing issues a given Secret and a second
 * opinion would be a guess. Here the objects come from different controllers
 * keying off different things, so a cluster running two has two real answers,
 * not one to discard.
 */
export function useServiceEdge(
  services: Array<{ namespace: string; name: string }>
): ServiceEdges {
  const suppliers = useCapabilities("service.edge");

  const wanted = [
    ...new Map(
      services.map((service) => [
        edgeKey(service.namespace, service.name),
        service,
      ])
    ),
  ].sort(([a], [b]) => a.localeCompare(b));

  const results = useQueries({
    queries: wanted.map(([key, service]) => ({
      queryKey: ["service-edge", key],
      queryFn: async () => {
        const answers = await Promise.all(
          suppliers.map((ask) =>
            ask({ namespace: service.namespace, name: service.name })
          )
        );
        return answers.flat();
      },
      enabled: suppliers.length > 0,
      // A BackendConfig changes when somebody edits it, which is a deploy and
      // not a heartbeat — the same minute the routing pages already use.
      staleTime: 60_000,
    })),
  });

  return {
    available: suppliers.length > 0,
    configs: new Map(
      wanted.flatMap(([key], index) => {
        const result = results[index];
        return result?.isSuccess ? [[key, result.data] as const] : [];
      })
    ),
    error: (results.find((result) => result.error)?.error as Error) ?? null,
  };
}
