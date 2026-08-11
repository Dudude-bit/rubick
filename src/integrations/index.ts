/**
 * Everything the app knows about a specific vendor's product, and the only
 * door into it.
 *
 * Kubernetes core is what the kubeconfig already reaches and what every
 * cluster answers for. This tree is the rest: cert-manager, Traefik, Istio,
 * Flux, and the three clouds' spellings of the facts their nodes already
 * carry. A surface asks for a facet and gets an implementation or nothing.
 * It never learns which vendor answered, or whether one did.
 *
 * The name is `integrations/` and it spans all three tiers, including tier
 * one, which is neither detected nor configured. What decides that
 * something lives here is not the tier but one question: *is this knowledge
 * about a specific vendor's product?* See `registry.ts` for the rest of the
 * rule and for what is deliberately outside it.
 *
 * ## Adding a vendor
 *
 * Two files, both in this tree, and nothing anywhere else:
 *
 * 1. `src/integrations/<id>/index.ts` — `defineVendor({ … })` with the
 *    facets it has. Put anything bulky beside it in the same folder:
 *    `crd.ts` for a page of column definitions, a client, a config form.
 * 2. `src/integrations/index.ts` — one import and one entry in
 *    {@link VENDORS}.
 *
 * That is the whole procedure, and it holds for a vendor that brings a whole
 * screen: `page: { count, load }` beside `extension` puts a row in the
 * sidebar's Integrations category and serves the screen at
 * `/integrations/<id>`, through the one route `App.tsx` already has. No
 * surface is edited, no switch statement grows a case, nothing is registered
 * at startup, and no test outside this tree changes — every consumer reads
 * the facet through a derivation below, so a new vendor's labels, columns,
 * marks and pages appear wherever the existing ones already do.
 *
 * Two exceptions, both of which stay inside the tree: a genuinely new
 * *capability* (as opposed to a new supplier of an existing one) adds a key
 * to `Capabilities` in `registry.ts` and needs a surface written to consume
 * it; and a new cluster *flavour* adds a member to `ClusterProvider` there
 * too, because that union is what keeps the mark table exhaustive.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  lazy,
  useMemo,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import type { LucideIcon } from "lucide-react";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { integrationPagePath } from "./paths";
import argocd from "./argocd";
import aws, { awsLoadBalancerController } from "./aws";
import azure, { aksAddons } from "./azure";
import certManager from "./cert-manager";
import flux, { helmReleasePath } from "./flux";
import googleCloud, { gkeIngress } from "./google-cloud";
import ingressNginx from "./ingress-nginx";
import istio from "./istio";
import k3s from "./k3s";
import karpenter from "./karpenter";
import loki from "./loki";
import minikube from "./minikube";
import prometheus from "./prometheus";
import traefik from "./traefik";
import { normalizeTauriError } from "@/lib/error-utils";
import type {
  CapabilityKey,
  CapabilityState,
  Capabilities,
  ClusterProvider,
  Connect,
  ConnectionDraft,
  CrdView,
  EdgeConfig,
  Extension,
  Flavour,
  HistoryLine,
  LogHistory,
  LogHistoryPage,
  LogScope,
  ProbeResult,
  SavedConnection,
  TrafficWindow,
  UsageRange,
  UsageScope,
  UsageWindow,
  Vendor,
  VendorFact,
  VendorPage,
  VolumeFullness,
} from "./registry";

export { RANGE_WINDOW_MS, USAGE_RANGES } from "./registry";
export type {
  CapabilityKey,
  CapabilityState,
  Capabilities,
  ClusterProvider,
  Connect,
  ConnectionDraft,
  CrdView,
  EdgeConfig,
  Extension,
  HistoryLine,
  LogHistory,
  LogHistoryPage,
  LogScope,
  ProbeResult,
  SavedConnection,
  TrafficWindow,
  UsageRange,
  UsageScope,
  UsageWindow,
  Vendor,
  VendorFact,
  VendorPage,
  VolumeFullness,
};

/**
 * The delivery vocabulary, through the door rather than from the file.
 *
 * `gitops.ts` is not a vendor folder — it is the handful of facts Argo and Flux
 * genuinely share — but the guard covers the whole tree by path and should:
 * "where is the git-remote parser" wants exactly one answer, and a surface
 * reaching for `@/integrations/gitops` is one import away from reaching for
 * `@/integrations/argocd`.
 */
export {
  deliveryKey,
  gitRepoLink,
  gitRevisionLink,
  shortRevision,
} from "./gitops";
export type {
  Delivery,
  DeliveryOwner,
  DeliveryQuery,
  DeliverySource,
  GitLink,
} from "./gitops";

/**
 * Every vendor that ships in the binary.
 *
 * A list, not a plugin API: third parties loading code into the app is a
 * different product with a different threat model. Order is meaningful and
 * is the only tie-break in the tree — where two vendors could claim the
 * same node label or the same context name, the earlier one wins, so the
 * more specific vendor goes first.
 */
const VENDORS: Vendor[] = [
  certManager,
  traefik,
  ingressNginx,
  argocd,
  flux,
  istio,
  prometheus,
  loki,
  k3s,
  // Each cloud's controllers sit immediately before the cloud itself. The
  // order between the two carries nothing — a tier-two record declares no
  // node label, no flavour and no provider scheme, so it can win no tie-break
  // — and keeping the pair adjacent is what stops the tier-one ordering,
  // which *is* load-bearing, from being read as arbitrary.
  awsLoadBalancerController,
  aws,
  gkeIngress,
  googleCloud,
  karpenter,
  aksAddons,
  azure,
  minikube,
];

/**
 * What is installed in the connected cluster.
 *
 * One CRD list per cluster, and it does not change while the app is open
 * often enough to be worth polling — an install is a deliberate act, and a
 * reader who has just done one can switch context or reopen.
 */
function useDetected() {
  return useQuery({
    queryKey: ["in-cluster-extensions"],
    queryFn: commands.detectInClusterExtensions,
    staleTime: 5 * 60_000,
  });
}

/** Every vendor the reader gives an address to, in registry order. */
const CONNECTED: ReadonlyArray<Vendor & { connect: Connect }> = VENDORS.filter(
  (vendor): vendor is Vendor & { connect: Connect } =>
    vendor.connect !== undefined
);

/**
 * What a configured vendor is doing for this cluster.
 *
 * Three states because there are three, and the middle one is the whole
 * reason this exists: a vendor that was configured and is not answering must
 * never look like one nobody set up.
 */
export type ConnectionState =
  | { state: "reading" }
  | { state: "notConfigured" }
  | { state: "connected"; saved: SavedConnection; probe: ProbeResult }
  | { state: "unreachable"; saved: SavedConnection; reason: string };

/**
 * The saved address and the probe, for every tier-3 vendor.
 *
 * One read plus one probe per configured vendor, on the same cadence the
 * detection scan uses — an address is a deliberate act and does not change
 * while the app is open often enough to poll for. A cluster with none of
 * them configured makes no requests at all: `read` answers `null` from the
 * config file and the probe never runs.
 *
 * Keyed on the context, so switching clusters asks again rather than
 * offering the staging Prometheus's answers for production.
 */
function useConnections(): Map<string, ConnectionState> {
  const context = useClusterStore((state) => state.currentContext);

  const saved = useQueries({
    queries: CONNECTED.map((vendor) => ({
      queryKey: ["integration-connection", vendor.id, context],
      queryFn: () => vendor.connect.read(),
      enabled: context !== null,
      staleTime: CONNECTION_STALE_TIME,
    })),
  });

  const probes = useQueries({
    queries: CONNECTED.map((vendor, index) => ({
      queryKey: ["integration-probe", vendor.id, context],
      queryFn: () => vendor.connect.probe(),
      enabled: context !== null && Boolean(saved[index]?.data),
      staleTime: CONNECTION_STALE_TIME,
      // A Prometheus that has gone away should stop being retried behind the
      // reader's back; the row and the chart both say so, and there is a
      // Test button for asking again on purpose.
      retry: false,
    })),
  });

  return new Map(
    CONNECTED.map((vendor, index): [string, ConnectionState] => {
      // No cluster is no question: an address is stored against a context,
      // so without one there is nothing to have configured. `isLoading`
      // rather than `isPending` for the same reason — a disabled query is
      // pending forever, and a row stuck on "asking…" would be a lie.
      if (context === null) return [vendor.id, { state: "notConfigured" }];
      const connection = saved[index];
      const probe = probes[index];
      if (connection?.isLoading) return [vendor.id, { state: "reading" }];
      if (!connection?.data) return [vendor.id, { state: "notConfigured" }];
      if (probe?.isLoading) return [vendor.id, { state: "reading" }];
      if (probe?.error) {
        return [
          vendor.id,
          {
            state: "unreachable",
            saved: connection.data,
            reason: normalizeTauriError(probe.error),
          },
        ];
      }
      if (!probe?.data?.ok) {
        return [
          vendor.id,
          {
            state: "unreachable",
            saved: connection.data,
            reason: probe?.data?.ok === false ? probe.data.reason : "no answer",
          },
        ];
      }
      return [
        vendor.id,
        { state: "connected", saved: connection.data, probe: probe.data },
      ];
    })
  );
}

/**
 * How long a connection's answer stands. Longer than the facts, because a
 * probe is a network round trip to somebody else's server and the Test
 * button exists for the reader who wants one now.
 */
const CONNECTION_STALE_TIME = 5 * 60_000;

/**
 * The implementation of a capability, or `null`.
 *
 * `null` is not an error state and the caller must not draw it as one: it
 * is the answer for the majority of clusters, and every surface that asks
 * owes a whole page without it.
 *
 * Fine for a tier-1 or tier-2 capability, where absent is the only way to
 * not have one. A surface consuming a *configured* vendor's capability wants
 * {@link useCapabilityState} instead — this hook collapses "nobody
 * configured one" and "the one you configured is down" into the same `null`,
 * and those are two different sentences the reader is owed.
 */
export function useCapability<K extends CapabilityKey>(
  key: K
): Capabilities[K] | null {
  return useCapabilities(key)[0] ?? null;
}

/**
 * A capability, its absence, or its breakage — with the words for each.
 *
 * The surface gets `vendor` and `endpoint` as strings to print and must not
 * branch on them: "from prometheus.monitoring:9090" is what makes a chart's
 * numbers attributable, and a chart whose provenance is unstated is a chart
 * nobody can check.
 */
export function useCapabilityState<K extends CapabilityKey>(
  key: K
): CapabilityState<K> {
  const { data } = useDetected();
  const connections = useConnections();

  const installed = new Set(
    (data ?? []).filter((entry) => entry.installed).map((entry) => entry.id)
  );

  for (const vendor of VENDORS) {
    const implementation = vendor.provides?.[key];
    if (!implementation) continue;

    if (!vendor.connect) {
      // Tier 1 and 2: present or not, and not-present has one answer.
      if (installed.has(vendor.id)) {
        return {
          state: "ready",
          vendor: vendor.name,
          endpoint: "",
          use: implementation as Capabilities[K],
        };
      }
      continue;
    }

    const connection = connections.get(vendor.id);
    if (!connection || connection.state === "notConfigured") continue;
    if (connection.state === "reading") continue;
    if (connection.state === "unreachable") {
      return {
        state: "unreachable",
        vendor: vendor.name,
        endpoint: endpointOf(connection.saved.url),
        reason: connection.reason,
      };
    }
    return {
      state: "ready",
      vendor: vendor.name,
      endpoint: endpointOf(connection.saved.url),
      use: implementation as Capabilities[K],
    };
  }

  return { state: "absent" };
}

/** The address as a chart label wants it — no scheme, no trailing slash. */
function endpointOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Every installed vendor that supplies a capability, in registry order.
 *
 * {@link useCapability} answers with the first, which is right where the
 * question has one answer: one thing issues the certificate in a given Secret,
 * and asking a second vendor about it would be asking it to guess.
 *
 * Delivery is not that question. Argo CD and Flux are routinely installed side
 * by side — one team's namespace under each — and on such a cluster the *first*
 * provider is the wrong answer for half the objects and would silently return
 * `null` for them. Worse, an object both controllers really do apply is a fact
 * worth shouting, and a lookup that stopped at the first hit could never find
 * it. So the surfaces that need it ask everybody and reconcile the answers
 * themselves.
 */
export function useCapabilities<K extends CapabilityKey>(
  key: K
): Array<Capabilities[K]> {
  const { data } = useDetected();
  const installed = new Set(
    (data ?? []).filter((entry) => entry.installed).map((entry) => entry.id)
  );
  return VENDORS.flatMap((vendor) => {
    const found = installed.has(vendor.id) ? vendor.provides?.[key] : undefined;
    return found ? [found as Capabilities[K]] : [];
  });
}

/**
 * A vendor's own glyph, by the id a capability answered with.
 *
 * The seam's rule is that a surface never learns *which* vendor answered, and
 * this does not break it: the surface is handed an opaque id and gets back a
 * mark, exactly as it is handed a `vendor` string and prints it. What it must
 * not do is branch on the id, and there is nothing here to branch on — an id
 * this registry does not know draws no glyph rather than a wrong one.
 */
export function vendorIcon(vendorId: string): LucideIcon | null {
  return (
    VENDORS.find((vendor) => vendor.id === vendorId)?.extension?.icon ?? null
  );
}

/**
 * A detected extension's facts, or the reason there are none.
 *
 * `failed` is a third thing from installed and absent, and it has to be:
 * a row that fell back to an empty fact list would state, in the app's own
 * quiet voice, that a cluster with two hundred certificates has none.
 */
export type FactsState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; facts: VendorFact[] }
  | { state: "failed"; reason: string };

export interface IntegrationStatus {
  vendor: Vendor;
  /** Narrowed off the vendor, because only vendors with one are listed. */
  extension: Extension;
  /**
   * Present and usable. For a detected vendor that is "its CRDs are here";
   * for a configured one it is "it has an address and the address answered",
   * which is what keeps the row's promise honest — a row saying "detected"
   * over a Prometheus that is refusing every query would be the silent
   * fallback this whole seam exists to prevent.
   */
  installed: boolean;
  version: string | null;
  facts: FactsState;
  /** `null` for a vendor nobody gives an address to. */
  connection: ConnectionState | null;
}

/**
 * How long a count is allowed to stand before it is read again.
 *
 * The pane is glanced at, not watched, so nothing polls: opening it reads
 * the cluster, and opening it again within the minute does not. A number on
 * screen is therefore at most one pane-open old, which is why it is stated
 * without a timestamp and without a live mark — it never claims to be
 * either.
 */
const FACTS_STALE_TIME = 60_000;

/** Every vendor that is an installable extension, in registry order. */
const EXTENSIONS: ReadonlyArray<Vendor & { extension: Extension }> =
  VENDORS.filter(
    (vendor): vendor is Vendor & { extension: Extension } =>
      vendor.extension !== undefined
  );

/**
 * The names the Integrations pane says it looked for when it found none.
 *
 * Detected ones only. A configured integration was never *looked* for — it
 * is absent because nobody gave it an address, not because the API server
 * was asked and said no — and listing it under "looked for by asking the API
 * server for their CRDs" would state a method that was never used.
 */
export const EXTENSION_NAMES: readonly string[] = EXTENSIONS.filter(
  (vendor) => vendor.connect === undefined
).map((vendor) => vendor.name);

/**
 * Every extension this cluster could have, whether it has it, and what the
 * ones it has are currently doing — for the one screen allowed to name them.
 *
 * Only vendors declaring {@link Extension} appear, which is what keeps the
 * cluster's own flavour out: GKE and k3s are vendors in this tree too, and
 * "Google Cloud · not installed" is nonsense — you cannot have a cluster
 * and not have the thing running it.
 *
 * Facts are fetched for detected extensions only. An absent one is not
 * asked about, because the objects it would count cannot exist; and nothing
 * is fetched at all unless the reader is standing on the pane, so mounting
 * this to answer a search query costs no requests.
 *
 * A configured vendor never appears in the detection scan and must not: it
 * is present because somebody gave it an address, and its facts come from
 * the probe rather than from a query it would have to make twice.
 */
export function useIntegrations({ facts = true }: { facts?: boolean } = {}): {
  statuses: IntegrationStatus[];
  isPending: boolean;
  error: Error | null;
} {
  const { data, isPending, error } = useDetected();
  const connections = useConnections();

  const detected = EXTENSIONS.map((vendor) => {
    const connection = vendor.connect
      ? (connections.get(vendor.id) ?? { state: "reading" as const })
      : null;
    const entry = data?.find((candidate) => candidate.id === vendor.id);
    return {
      vendor,
      connection,
      installed: connection
        ? connection.state === "connected"
        : (entry?.installed ?? false),
      version: connection
        ? connection.state === "connected"
          ? connection.probe.ok
            ? connection.probe.version
            : null
          : null
        : (entry?.version ?? null),
    };
  });

  const asking = detected.filter(
    ({ vendor, installed }) => installed && vendor.extension.facts
  );

  const results = useQueries({
    queries: asking.map(({ vendor }) => ({
      queryKey: ["integration-facts", vendor.id],
      queryFn: () => vendor.extension.facts!(),
      enabled: facts,
      staleTime: FACTS_STALE_TIME,
    })),
  });

  return {
    statuses: detected.map(({ vendor, installed, version, connection }) => {
      const index = asking.findIndex((entry) => entry.vendor.id === vendor.id);
      return {
        vendor,
        extension: vendor.extension,
        installed,
        version,
        connection,
        facts: connection
          ? connectionFacts(vendor, connection)
          : factsStateOf(index === -1 ? undefined : results[index]),
      };
    }),
    isPending,
    error,
  };
}

/**
 * A configured vendor's facts, taken from the probe it already ran.
 *
 * A broken one says so *here*, once, instead of leaving the reader to infer
 * it from a chart that quietly went shorter — which is the reason this row
 * is worth reading at all.
 */
function connectionFacts(
  vendor: Vendor & { connect?: Connect },
  connection: ConnectionState
): FactsState {
  if (!vendor.connect) return { state: "none" };
  switch (connection.state) {
    case "reading":
      return { state: "loading" };
    case "notConfigured":
      return { state: "none" };
    case "unreachable":
      return {
        state: "ready",
        facts: vendor.connect.facts(connection.saved, {
          ok: false,
          at: Date.now(),
          reason: connection.reason,
        }),
      };
    case "connected":
      return {
        state: "ready",
        facts: vendor.connect.facts(connection.saved, connection.probe),
      };
  }
}

/**
 * Everything the Connect dialog needs, for one vendor, without naming it.
 *
 * The pane is handed the vendor from {@link useIntegrations} and passes its
 * id back, so the one screen allowed to *say* "Prometheus" still never
 * imports it.
 */
export function useConnectionEditor(vendorId: string): {
  connect: Connect | null;
  saved: SavedConnection | null;
  save: (draft: ConnectionDraft) => Promise<void>;
  forget: () => Promise<void>;
  test: (draft: ConnectionDraft) => Promise<ProbeResult>;
  isSaving: boolean;
} {
  const context = useClusterStore((state) => state.currentContext);
  const client = useQueryClient();
  const vendor = CONNECTED.find((candidate) => candidate.id === vendorId);

  // Both keys, because saving an address changes what is stored *and*
  // whether it answers, and a row still reading "not configured" after a
  // successful save would be the app disagreeing with itself.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: ["integration-connection", vendorId, context],
      }),
      client.invalidateQueries({
        queryKey: ["integration-probe", vendorId, context],
      }),
    ]).then(() => undefined);

  const saving = useMutation({
    mutationFn: async (draft: ConnectionDraft | null) => {
      if (!vendor) return;
      if (draft === null) await vendor.connect.forget();
      else await vendor.connect.save(draft);
      await refresh();
    },
  });

  const { data: saved = null } = useQuery({
    queryKey: ["integration-connection", vendorId, context],
    queryFn: () => vendor!.connect.read(),
    enabled: vendor !== undefined && context !== null,
    staleTime: CONNECTION_STALE_TIME,
  });

  return {
    connect: vendor?.connect ?? null,
    saved,
    save: (draft) => saving.mutateAsync(draft).then(() => undefined),
    forget: () => saving.mutateAsync(null).then(() => undefined),
    test: (draft) =>
      vendor
        ? vendor.connect.probe(draft)
        : Promise.resolve({
            ok: false as const,
            at: Date.now(),
            reason: "no such integration",
          }),
    isSaving: saving.isPending,
  };
}

function factsStateOf(
  result: { data?: VendorFact[]; error: Error | null } | undefined
): FactsState {
  if (!result) return { state: "none" };
  // Checked before `data`, because react-query keeps the last good answer
  // through a failed refetch and a count nobody could re-read is not a
  // count worth printing.
  if (result.error) {
    return { state: "failed", reason: normalizeTauriError(result.error) };
  }
  if (result.data) return { state: "ready", facts: result.data };
  return { state: "loading" };
}

// --- the pages ----------------------------------------------------------

/**
 * Every vendor that owns a screen, in registry order.
 *
 * Narrowed on `extension` as well as on `page`, because the sidebar row a
 * page gets is drawn from the extension's glyph and the vendor's name, and
 * the category lists only what the cluster was detected to have.
 */
const PAGES: ReadonlyArray<
  Vendor & { extension: Extension; page: VendorPage }
> = VENDORS.filter(
  (vendor): vendor is Vendor & { extension: Extension; page: VendorPage } =>
    vendor.page !== undefined && vendor.extension !== undefined
);

/**
 * `React.lazy` per vendor, made once.
 *
 * Calling `lazy()` in render would hand React a new component type on every
 * pass, which remounts the page and re-runs its queries on every keystroke
 * the reader types into it.
 */
const LAZY = new Map<string, LazyExoticComponent<ComponentType>>();

function lazyPageOf(vendorId: string, page: VendorPage) {
  const made = LAZY.get(vendorId);
  if (made) return made;
  const component = lazy(page.load);
  LAZY.set(vendorId, component);
  return component;
}

export interface IntegrationPageEntry {
  id: string;
  name: string;
  icon: LucideIcon;
  path: string;
  /** `null` while it is being read, and where the cluster refused to say. */
  count: number | null;
}

/**
 * The Integrations category: one row per *detected* vendor that owns a
 * screen, or an empty list.
 *
 * Empty is the answer for most clusters and the caller must draw nothing at
 * all for it — not an empty group, not a placeholder. Hiding it is only safe
 * because Settings → Integrations names every extension the app knows,
 * installed or not, with what each one would give; that screen is where
 * "what could this app do" is answered, and this one stays a list of things
 * the cluster actually has.
 */
export function useIntegrationPages(): IntegrationPageEntry[] {
  const { data } = useDetected();

  const detected = PAGES.filter((vendor) =>
    data?.some((entry) => entry.id === vendor.id && entry.installed)
  );

  // The page's own query, verbatim. Two observers on one cache entry, so a
  // reader who opens the page finds it already answered and the app makes
  // one set of reads instead of two.
  const counts = useQueries({
    // `select` is declared over the payload the vendor's own query returns and
    // erased at the registry boundary, so the list can hold every vendor's
    // count without this file knowing what any of them reads.
    queries: detected.map(
      (vendor) =>
        vendor.page.count as unknown as UseQueryOptions<
          unknown,
          Error,
          number | null
        >
    ),
  });

  return detected.map((vendor, index) => ({
    id: vendor.id,
    name: vendor.name,
    icon: vendor.extension.icon,
    path: integrationPagePath(vendor.id),
    count: counts[index]?.data ?? null,
  }));
}

/**
 * What is at `/integrations/<slug>`.
 *
 * Four answers rather than a component or `null`, because the three
 * not-a-page cases read differently to somebody who arrived by a stale link,
 * a restored tab or a cluster switch: a slug no vendor claims is a typo, a
 * vendor the cluster does not have is a cluster answer, and detection still
 * running is neither.
 */
export type IntegrationPageState =
  | { state: "detecting" }
  | { state: "unknown" }
  | { state: "absent"; name: string; icon: LucideIcon }
  | {
      state: "ready";
      name: string;
      icon: LucideIcon;
      Page: LazyExoticComponent<ComponentType>;
    };

export function useIntegrationPage(
  slug: string | undefined
): IntegrationPageState {
  const { data, isPending } = useDetected();
  const vendor = PAGES.find((candidate) => candidate.id === slug);

  if (!vendor) return { state: "unknown" };
  if (isPending || !data) return { state: "detecting" };

  const installed = data.some(
    (entry) => entry.id === vendor.id && entry.installed
  );
  if (!installed) {
    return { state: "absent", name: vendor.name, icon: vendor.extension.icon };
  }
  return {
    state: "ready",
    name: vendor.name,
    icon: vendor.extension.icon,
    Page: lazyPageOf(vendor.id, vendor.page),
  };
}

/**
 * The vendor view for a custom resource's API group, or `null` for the
 * thousands of CRDs nobody here has heard of — which get the CRD's own
 * printer columns, exactly as they did before this tree existed.
 *
 * No detection call: reaching a `cert-manager.io` list page requires the
 * group to exist, so the group is the detection.
 */
export function useCrdView(group: string, kind: string): CrdView | null {
  return useMemo(() => crdViewFor(group, kind), [group, kind]);
}

function crdViewFor(group: string, kind: string): CrdView | null {
  return (
    VENDORS.find((vendor) => vendor.crd?.matches(group, kind))?.crd ?? null
  );
}

/**
 * Every label a vendor uses to name the pool a node was made by, in
 * registry order, so the first hit is the more specific vendor's.
 *
 * Flattened once at module load rather than per node: a forty-node list
 * asks this question forty times and the answer cannot change.
 */
export const NODE_POOL_LABELS: readonly string[] = VENDORS.flatMap(
  (vendor) => vendor.nodeLabels?.pool ?? []
);

/**
 * Every label that means "the cloud may take this node back", with the
 * value that means yes.
 *
 * Only "yes" is listed. `capacityType=ON_DEMAND` and `priority=regular`
 * exist and are not read, because nothing in the app ever states that a
 * node is *not* spot.
 */
export const NODE_SPOT_LABELS: ReadonlyArray<
  readonly [key: string, value: string]
> = VENDORS.flatMap((vendor) => vendor.nodeLabels?.spot ?? []);

/**
 * The cloud that writes a given `spec.providerID` scheme, or `null`.
 *
 * A scheme no vendor here claims is left unnamed rather than guessed at —
 * and plenty of clusters have one, k3s and RKE2 included.
 */
export function cloudOfProviderScheme(scheme: string): string | null {
  const match = VENDORS.find(
    (vendor) => vendor.nodeLabels?.providerScheme?.[0] === scheme
  );
  return match?.nodeLabels?.providerScheme?.[1] ?? null;
}

/**
 * Every flavour a kubeconfig context can be recognised as, in registry
 * order — which is the order they are tested in, most specific vendor
 * first. Deliberately not exported: nothing outside needs the list, only
 * the two answers below.
 */
const FLAVOURS: readonly Flavour[] = VENDORS.flatMap(
  (vendor) => vendor.flavours ?? []
);

/**
 * The flavour whose vendor claims this context name, or `null` for the
 * generic case — a cluster run by somebody this app has never heard of,
 * which is a perfectly ordinary thing for a cluster to be.
 */
export function flavourOfContext(context: string): Flavour | null {
  const name = context.toLowerCase();
  // "aks" inside "peaks-cluster" is not Azure, so markers are matched as
  // whole segments of a name that separates words with -, _, . or :.
  const hasWord = (word: string) =>
    new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(name);
  return FLAVOURS.find((flavour) => flavour.claims(name, hasWord)) ?? null;
}

/** The flavour a provider id names, for the surfaces that hold one already. */
export function flavourOf(provider: ClusterProvider): Flavour | null {
  return FLAVOURS.find((flavour) => flavour.id === provider) ?? null;
}

/**
 * Where a Flux-managed Helm release's real object lives.
 *
 * The one facet that names its vendor out loud, because the surface that
 * uses it already does: the Helm page says "Managed by Flux" before it
 * offers the link. Naming a vendor in *copy* was never the problem; naming
 * one in an `import` is.
 */
export { helmReleasePath as fluxHelmReleasePath };
export { integrationPagePath };
