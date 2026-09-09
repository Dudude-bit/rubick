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
import { normalizeTauriError } from "@/lib/error-utils";
import { addressIn, type Chain, type Trouble } from "@/lib/hints";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";
import type { PodInfo } from "@/generated/types";

const LOG_LINES = 40;
const STALE = 15_000;

/**
 * Everything the sentence is built from: the pod's events, the last lines
 * of the troubled container, and the Service behind the address those
 * lines named, each read separately so a refusal on one is one line in
 * "Not read" rather than a panel that does not appear.
 */
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

  const address = useMemo(() => addressIn(logs.data ?? []), [logs.data]);
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
  const service = useMemo(() => {
    if (!inCluster || !services.data) return null;
    const host = inCluster.host.toLowerCase();
    const bare = host.split(".")[0];
    return (
      services.data.find(
        (svc) =>
          svc.clusterIp === inCluster.host ||
          svc.name.toLowerCase() === host ||
          (host.includes(".svc") && svc.name.toLowerCase() === bare)
      ) ?? null
    );
  }, [inCluster, services.data]);

  const endpoints = useQuery({
    queryKey: [context, "hints", "endpoints", pod.namespace, service?.name],
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
    const ready =
      endpoints.data?.subsets.reduce((sum, s) => sum + s.addresses.length, 0) ??
      null;
    const notReady =
      endpoints.data?.subsets.reduce(
        (sum, s) => sum + s.notReadyAddresses.length,
        0
      ) ?? null;
    const sidecar =
      address?.where === "sidecar"
        ? (pod.containers.find(
            (c) =>
              c.name !== logContainer &&
              c.name !==
                (trouble && "container" in trouble ? trouble.container : "")
          ) ?? null)
        : null;
    return {
      address,
      service:
        service && ready !== null && notReady !== null
          ? {
              name: service.name,
              namespace: pod.namespace,
              ready,
              total: ready + notReady,
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
    services.error,
    logs.error,
    logContainer,
    pod,
    trouble,
    t,
  ]);

  return { chain, logLines: logs.data ?? [], logContainer, previous };
}
