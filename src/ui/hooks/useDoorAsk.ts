import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useGatewayApi } from "@/hooks/useGatewayApi";
import { ROUTING_STALE, useCapabilities } from "@/integrations";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { knownOf } from "@/lib/known";
import type { DoorAsk } from "@/lib/policy-door";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";

/** A controller's pods move with a rollout, not by the second. */
const CLIENTS_STALE = 60_000;

/**
 * Who each IngressClass and GatewayClass controller connects from, asked
 * once per controller an integration claims, so every surface judges a
 * backend's NetworkPolicies against the same pods.
 */
export function useDoorAsk(enabled = true): DoorAsk {
  const suppliers = useCapabilities("ingress.clients");
  const supplied = enabled && suppliers.length > 0;
  const classes = useQuery({
    queryKey: queryKeys.ingressClass(null),
    queryFn: () => commands.resolveIngressClass(null),
    enabled: supplied,
  });
  const gatewayApi = useGatewayApi().data;
  const gatewayClasses = useQuery({
    queryKey: queryKeys.gatewayClasses(),
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled:
      supplied &&
      !!gatewayApi?.kinds.some((kind) => kind.kind === "GatewayClass"),
  });
  const claims = useMemo(() => {
    const controllers = new Set([
      ...(classes.data?.available ?? []).flatMap((entry) =>
        entry.controller ? [entry.controller] : []
      ),
      ...(gatewayClasses.data ?? []).map((entry) => entry.controllerName),
    ]);
    return [...controllers].sort().flatMap((controller) => {
      const claim = suppliers
        .map((supply) => supply(controller))
        .find((found) => found !== null);
      return claim ? [{ controller, claim }] : [];
    });
    // The suppliers change only with the integrations detected, as the classes do.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [classes.data, gatewayClasses.data, suppliers.length]);
  const reads = useQueries({
    queries: claims.map(({ controller, claim }) => ({
      queryKey: queryKeys.ingressClients(controller),
      queryFn: claim.read,
      staleTime: CLIENTS_STALE,
    })),
  });
  const homes = reads.map((read) =>
    read.data
      ? [...new Set(read.data.map((client) => client.namespace))].sort()
      : []
  );
  const egress = useQueries({
    queries: claims.map(({ controller }, at) => ({
      queryKey: queryKeys.ingressClientPolicies(controller, homes[at]),
      queryFn: () => commands.listNetworkPoliciesIn(homes[at]),
      enabled: homes[at].length > 0,
      staleTime: STALE_TIMES.slow,
    })),
  });
  const namespaces = useQuery({
    queryKey: queryKeys.namespaces(),
    queryFn: () => commands.listNamespaces(),
    enabled: claims.length > 0,
    staleTime: STALE_TIMES.slow,
  });
  const answers = reads.map(knownOf);
  const policies = egress.map(knownOf);
  const digest = JSON.stringify([answers, policies]);
  const listed = knownOf(namespaces);
  const listedDigest = JSON.stringify(listed);
  const classesError = classes.error ?? gatewayClasses.error;
  const gatewayData = gatewayClasses.data;

  return useMemo<DoorAsk>(() => {
    const reads = new Map(
      claims.map(({ controller, claim }, at) => [
        controller,
        {
          name: claim.name,
          clients: answers[at],
          namespaces: listed,
          egress: policies[at],
        },
      ])
    );
    const ask: DoorAsk = (controller) => {
      const read = reads.get(controller);
      if (read) return read;
      const claim = suppliers
        .map((supply) => supply(controller))
        .find((found) => found !== null);
      if (!claim) return null;
      if (!classesError) return undefined;
      const why = errorToShow(classesError);
      return {
        name: claim.name,
        clients: { known: false, why },
        namespaces: listed,
        egress: { known: false, why },
      };
    };
    const named = gatewayData
      ? new Map(gatewayData.map((entry) => [entry.name, entry.controllerName]))
      : null;
    return Object.assign(ask, {
      classController: named ? (name: string) => named.get(name) : undefined,
    });
    // The answers are compared by what they say, not by the array React Query rebuilt.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [claims, digest, listedDigest, classesError, gatewayData]);
}
