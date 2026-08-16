/**
 * What the Argo CD page reads, and what it costs.
 *
 * One list call answers the sidebar's count and draws every row, because an
 * `Application`'s status carries its source, its destination, its resources
 * and its last failure in the same object. The other three — ApplicationSets,
 * projects, and the controller's own workloads — are only needed by the tabs
 * that name them, and are not fetched until one is opened.
 *
 * None of it is paged. "Which of my applications is not in sync" is a
 * question about all of them, and an answer for the first fifty is a wrong
 * answer.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";
import { covers } from "@/lib/certificates";
import type { ServiceRoute } from "../registry";
import { readApplication, type ArgoApp } from "./model";

export const GROUP = "argoproj.io";
export const APPLICATIONS_CRD = `applications.${GROUP}`;
export const APPLICATIONSETS_CRD = `applicationsets.${GROUP}`;
export const PROJECTS_CRD = `appprojects.${GROUP}`;

/** Every Argo component labels its own workload with this. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/part-of=argocd";

/** A minute: a sync takes minutes and the page is read, not watched. */
export const ARGO_STALE = 60_000;

export const APPLICATIONS_KEY = ["argocd", "applications"] as const;

export async function fetchApplications(): Promise<ArgoApp[]> {
  const objects = await commands.listCustomResources(
    APPLICATIONS_CRD,
    null,
    null,
    null
  );
  return objects.map(readApplication);
}

export function useApplications() {
  return useQuery({
    queryKey: APPLICATIONS_KEY,
    queryFn: fetchApplications,
    staleTime: ARGO_STALE,
  });
}

export function useApplicationSets() {
  return useQuery({
    queryKey: ["argocd", "applicationsets"],
    queryFn: () =>
      commands
        .listCustomResources(APPLICATIONSETS_CRD, null, null, null)
        // An Argo install without the ApplicationSet controller has no such
        // CRD, and a tab that said "could not be read" would be reporting a
        // supported install as broken.
        .catch((): CustomResourceInfo[] => []),
    staleTime: ARGO_STALE,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["argocd", "projects"],
    queryFn: () => commands.listCustomResources(PROJECTS_CRD, null, null, null),
    staleTime: ARGO_STALE,
  });
}

export interface ArgoComponent {
  kind: "Deployment" | "StatefulSet";
  name: string;
  namespace: string;
  image: string | null;
  ready: number;
  desired: number;
}

export interface ControllerInfo {
  components: ArgoComponent[];
  /** Where Argo's own UI answers, or `null` — see {@link uiAddress}. */
  ui: string | null;
  /** Where its workloads run, which is where `argocd-server` is too. */
  namespace: string;
  problem: string | null;
}

/**
 * Where Argo CD's own web UI is, and only where the cluster states it.
 *
 * This is the same judgement the image-registry link follows: an address is
 * offered when it falls out of an object mechanically, and never otherwise.
 * `argocd-server` is a ClusterIP with no route from the reader's machine, so
 * the only thing that makes the UI reachable is an Ingress somebody created
 * for it — and that Ingress states the host and whether it is served over
 * TLS. With no such Ingress there is no address to guess, and the page says
 * so rather than offering a link into a connection error.
 */
/** The Service Argo's own UI answers on, wherever it is routed from. */
export const SERVER_SERVICE = "argocd-server";

/**
 * The same address, from whatever routes `argocd-server` when no Ingress
 * does — see the `service.routes` capability.
 *
 * Three outcomes rather than a URL or nothing, because the middle one is
 * real and used to be invisible: a host this app can name but whose scheme
 * it cannot settle. Linking that host would be guessing at `https://` for
 * something that may only answer in the clear, and saying nothing about it
 * would repeat the bug this exists to fix — the reader knows the host, and
 * being told there is no address is what made the page wrong.
 */
export interface RoutedUi {
  /** Safe to link, or `null` where the scheme is not settled. */
  url: string | null;
  /** The hostname, where anything routes the Service at all. */
  host: string | null;
  /** What routes it, so the sentence can name the object. */
  via: ServiceRoute["source"] | null;
}

export function uiFromRoutes(routes: ServiceRoute[]): RoutedUi {
  // A route whose scheme is settled can be linked; among those, TLS wins,
  // because a host served both ways is one somebody should reach securely.
  const settled = routes.filter((route) => route.tls !== null);
  const best = settled.find((route) => route.tls) ?? settled[0] ?? routes[0];
  if (!best) return { url: null, host: null, via: null };
  return {
    url:
      best.tls === null
        ? null
        : `${best.tls ? "https" : "http"}://${best.host}${best.path === "/" ? "" : best.path}`,
    host: best.host,
    via: best.source,
  };
}

export function uiAddress(
  ingresses: IngressInfo[],
  namespace: string
): string | null {
  for (const ingress of ingresses) {
    if (ingress.namespace !== namespace) continue;
    const serves = ingress.rules.some((rule) =>
      rule.paths.some((path) => path.backendService === SERVER_SERVICE)
    );
    if (!serves) continue;
    const rule = ingress.rules.find((candidate) => candidate.host !== "");
    if (!rule) continue;
    // `covers`, not equality: a wildcard Secret is how most people serve a
    // subdomain, and read literally this returned `http://` for a host that
    // only answers on 443.
    const secure =
      ingress.hasCatchAllTls ||
      covers(ingress.tlsHosts, rule.host) ||
      ingress.tlsConfigs.some((config) => covers(config.hosts, rule.host));
    return `${secure ? "https" : "http"}://${rule.host}`;
  }
  return null;
}

export function useController() {
  return useQuery({
    queryKey: ["argocd", "controller"],
    queryFn: async (): Promise<ControllerInfo> => {
      const filters = {
        namespace: null,
        labelSelector: CONTROLLER_SELECTOR,
        fieldSelector: null,
        limit: null,
      };
      const [deployments, statefulSets, ingresses] = await Promise.all([
        commands.listDeployments(filters).catch(() => []),
        commands.listStatefulsets(filters).catch(() => []),
        commands.listIngresses(null).catch((): IngressInfo[] => []),
      ]);

      const components: ArgoComponent[] = [
        ...deployments.map((deployment) => ({
          kind: "Deployment" as const,
          name: deployment.name,
          namespace: deployment.namespace,
          image: deployment.containers[0]?.image ?? null,
          ready: deployment.replicas.ready,
          desired: deployment.replicas.desired,
        })),
        ...statefulSets.map((set) => ({
          kind: "StatefulSet" as const,
          name: set.name,
          namespace: set.namespace,
          // The list call carries no containers for a StatefulSet, and the
          // application controller is one. Its image is on its own page.
          image: null,
          ready: set.replicas.ready,
          desired: set.replicas.desired,
        })),
      ].sort((left, right) => left.name.localeCompare(right.name));

      const namespace = components[0]?.namespace ?? "argocd";
      return {
        components,
        ui: uiAddress(ingresses, namespace),
        namespace,
        problem:
          components.length === 0
            ? `Nothing in this cluster carries ${CONTROLLER_SELECTOR}, so Argo's own workloads could not be found. Its Applications are still read from the API server.`
            : null,
      };
    },
    staleTime: ARGO_STALE,
  });
}

/**
 * The deep link into Argo's own UI for one Application.
 *
 * The diff is the one thing Argo does better than this app could without a
 * credential, so it is handed over rather than approximated. `null` when
 * there is no address — see {@link uiAddress}.
 */
export function applicationUrl(
  ui: string | null,
  app: { name: string; namespace: string }
): string | null {
  if (!ui) return null;
  return `${ui}/applications/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}`;
}
