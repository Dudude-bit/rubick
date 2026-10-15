import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCapabilities } from "@/integrations";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { knownOf } from "@/lib/known";
import type { DoorAsk } from "@/lib/policy-door";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";

/** A controller's pods move with a rollout, not by the second. */
const CLIENTS_STALE = 60_000;

/**
 * Who each IngressClass controller connects from, asked once per
 * controller an integration claims, so every surface judges a backend's
 * NetworkPolicies against the same pods.
 */
export function useDoorAsk(enabled = true): DoorAsk {
  const suppliers = useCapabilities("ingress.clients");
  const supplied = enabled && suppliers.length > 0;
  const classes = useQuery({
    queryKey: queryKeys.ingressClass(null),
    queryFn: () => commands.resolveIngressClass(null),
    enabled: supplied,
  });
  const claims = useMemo(() => {
    const controllers = new Set(
      (classes.data?.available ?? []).flatMap((entry) =>
        entry.controller ? [entry.controller] : []
      )
    );
    return [...controllers].sort().flatMap((controller) => {
      const claim = suppliers
        .map((supply) => supply(controller))
        .find((found) => found !== null);
      return claim ? [{ controller, claim }] : [];
    });
    // The suppliers change only with the integrations detected, as the classes do.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [classes.data, suppliers.length]);
  const reads = useQueries({
    queries: claims.map(({ controller, claim }) => ({
      queryKey: queryKeys.ingressClients(controller),
      queryFn: claim.read,
      staleTime: CLIENTS_STALE,
    })),
  });
  const namespaces = useQuery({
    queryKey: queryKeys.namespaces(),
    queryFn: () => commands.listNamespaces(),
    enabled: claims.length > 0,
    staleTime: STALE_TIMES.slow,
  });
  const answers = reads.map(knownOf);
  const digest = JSON.stringify(answers);
  const listed = knownOf(namespaces);
  const listedDigest = JSON.stringify(listed);
  const classesError = classes.error;

  return useMemo<DoorAsk>(() => {
    const reads = new Map(
      claims.map(({ controller, claim }, at) => [
        controller,
        { name: claim.name, clients: answers[at], namespaces: listed },
      ])
    );
    return (controller) => {
      const read = reads.get(controller);
      if (read) return read;
      const claim = suppliers
        .map((supply) => supply(controller))
        .find((found) => found !== null);
      if (!claim) return null;
      if (!classesError) return undefined;
      return {
        name: claim.name,
        clients: { known: false, why: errorToShow(classesError) },
        namespaces: listed,
      };
    };
    // The answers are compared by what they say, not by the array React Query rebuilt.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [claims, digest, listedDigest, classesError]);
}
