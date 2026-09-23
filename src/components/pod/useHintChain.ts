/**
 * The chain behind a pod's trouble, read once for whoever asks.
 *
 * The panel says it in a sentence and the report writes it into a file;
 * both have to be the same reading, or a colleague opening the report sees
 * a verdict the screen never showed.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { normalizeTauriError } from "@/lib/error-utils";
import { addressIn, namespaceOf, type Chain, type Trouble } from "@/lib/hints";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";
import type { PodInfo } from "@/generated/types";

/** One array, so "no lines yet" is the same value on every render. */
const EMPTY_LINES: string[] = [];

const LOG_LINES = 40;
const STALE = 15_000;

export function useHintChain(
  pod: PodInfo,
  trouble: Trouble | null,
  wantLogs: boolean
) {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const logContainer =
    trouble && "container" in trouble && trouble.container
      ? trouble.container
      : null;
  const previous = trouble?.reason === "crashLoop";

  const logs = useQuery({
    queryKey: [
      context,
      "hints",
      "logs",
      pod.namespace,
      pod.name,
      logContainer,
      previous,
      pod.restartCount,
    ],
    queryFn: async () => {
      try {
        const lines = await commands.getPodLogs(
          pod.name,
          pod.namespace,
          logContainer,
          LOG_LINES,
          null,
          previous
        );
        return lines.map((line) => line.raw || line.message);
      } catch (error) {
        throw new Error(normalizeTauriError(error), { cause: error });
      }
    },
    enabled: wantLogs && logContainer !== null,
    staleTime: STALE,
    retry: false,
  });

  // The pod's own namespace is enough for `db.shop`: the cross-namespace
  // form every Kubernetes reader writes, which was called outside the
  // cluster and gated off the Service lookup.
  const namespaces = useMemo(() => [pod.namespace], [pod.namespace]);
  const address = useMemo(
    () => addressIn(logs.data ?? [], namespaces),
    [logs.data, namespaces]
  );
  const inCluster = address?.where === "inCluster" ? address : null;

  const services = useQuery({
    queryKey: [context, "hints", "services", pod.namespace],
    queryFn: () =>
      commands.listServices({
        namespace: pod.namespace,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
        serviceType: null,
      }),
    enabled: inCluster !== null,
    staleTime: STALE,
    retry: false,
  });
  /**
   * The Service the address names, matched with its namespace.
   *
   * `shop-db-rw.billing.svc.cluster.local` was matched on the bare name
   * against this namespace's Services, so a same-named Service next door
   * was reported — with its endpoint count — as the thing behind an
   * address in another namespace.
   */
  const service = useMemo(() => {
    if (!inCluster || !services.data) return null;
    const host = inCluster.host.toLowerCase();
    const labels = namespaceOf(host, pod.namespace);
    // Not this namespace: the app did not list that one, so it has not
    // looked rather than found nothing.
    if (labels.namespace !== pod.namespace) return null;
    const bare = labels.name;
    return (
      services.data.find(
        (svc) =>
          svc.clusterIp === inCluster.host ||
          svc.name.toLowerCase() === host ||
          (labels.qualified && svc.name.toLowerCase() === bare)
      ) ?? null
    );
  }, [inCluster, services.data, pod.namespace]);

  /** The address is in another namespace, which this app did not list. */
  const elsewhere = useMemo(() => {
    if (!inCluster) return null;
    const { namespace } = namespaceOf(
      inCluster.host.toLowerCase(),
      pod.namespace
    );
    return namespace === pod.namespace ? null : namespace;
  }, [inCluster, pod.namespace]);

  const endpoints = useQuery({
    queryKey: queryKeys.detail(
      ResourceType.Endpoints,
      pod.namespace,
      service?.name
    ),
    queryFn: () => commands.getEndpoints(service!.name, pod.namespace),
    enabled: service !== null,
    staleTime: STALE,
    retry: false,
  });

  const chain = useMemo<Chain>(() => {
    const notRead: string[] = [];
    if (logs.error && logContainer)
      notRead.push(
        t("hints", "notReadLogs", {
          container: logContainer,
          reason: logs.error.message,
        })
      );
    if (services.error)
      notRead.push(
        t("hints", "notReadService", {
          namespace: pod.namespace,
          reason: normalizeTauriError(services.error),
        })
      );
    if (endpoints.error && service)
      notRead.push(
        t("hints", "notReadEndpoints", {
          service: service.name,
          reason: normalizeTauriError(endpoints.error),
        })
      );
    if (address?.where === "outside")
      notRead.push(t("hints", "notReadPolicies"));
    if (elsewhere)
      notRead.push(
        t("hints", "notReadOtherNamespace", { namespace: elsewhere })
      );
    const ready =
      endpoints.data?.subsets.reduce((sum, s) => sum + s.addresses.length, 0) ??
      null;
    const notReady =
      endpoints.data?.subsets.reduce(
        (sum, s) => sum + s.notReadyAddresses.length,
        0
      ) ?? null;
    // The container that declares the port, not the next one in the list.
    // Declaration order named an unrelated container as the thing that is
    // not listening, and the pod's own `ports` answered the question.
    const sidecar =
      address?.where === "sidecar" && address.port !== null
        ? ([...pod.containers, ...pod.initContainers].find((c) =>
            c.ports.some((port) => port.containerPort === address.port)
          ) ?? null)
        : null;
    return {
      address,
      // A read that failed is not an answer. Without these, a 403 on the
      // Services of this namespace produced the same sentence as a cluster
      // where nothing answers to that address.
      // A Service in another namespace was never asked about, so nothing
      // here may say whether one answers to that address.
      servicesKnown:
        inCluster === null || (services.data !== undefined && !elsewhere),
      endpointsKnown: service === null || endpoints.data !== undefined,
      service: service
        ? {
            name: service.name,
            namespace: pod.namespace,
            // Found, but the endpoints behind it were not read: the count
            // is unknown rather than zero.
            ready: ready,
            total:
              ready !== null && notReady !== null ? ready + notReady : null,
          }
        : null,
      sidecar,
      notRead,
    };
  }, [
    address,
    service,
    endpoints.data,
    endpoints.error,
    elsewhere,
    inCluster,
    services.data,
    services.error,
    logs.error,
    logContainer,
    pod,
    t,
  ]);

  // A fresh `[]` every call is a new dependency every render, and the report
  // it feeds is rebuilt each time — see `usePodReport`, whose memo lists it.
  const logLines = useMemo(() => logs.data ?? EMPTY_LINES, [logs.data]);

  return { chain, logLines, logContainer, previous };
}
