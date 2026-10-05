import type { QueryKey } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { getApiVersion, toKind } from "@/lib/resource-registry";
import { vendorPeek } from "@/integrations";
import type { PeekTarget } from "@/hooks/usePeek";
import type { CustomResourceDetailInfo } from "@/generated/types";
import {
  controlledBy,
  source,
  type PeekSource,
  type PeekSources,
} from "./peek-sources-kit";
import { flatten, objectFacets, stateOf } from "../-object/facets";
import { servedOfKind } from "../-object/ownership";
import { CLUSTER_SOURCES } from "./peek-sources-cluster";
import { GATEWAY_SOURCES } from "./peek-sources-gateway";
import { WORKLOAD_SOURCES } from "./peek-sources-workloads";
import { CONFIG_STORAGE_SOURCES } from "./peek-sources-storage";
import { endpointSliceSource, NETWORK_SOURCES } from "./peek-sources-network";

export type { PeekGroup, PeekSummary } from "./peek-sources-kit";
export { flatten };

/**
 * What each kind says about itself in the peek's Overview tab.
 *
 * Kind to the command its detail page already uses, plus the handful of rows
 * that page leads with. Anything missing here falls back to the raw manifest,
 * which every kind answers.
 */
const SOURCES: PeekSources = {
  ...CLUSTER_SOURCES,
  ...GATEWAY_SOURCES,
  ...WORKLOAD_SOURCES,
  ...CONFIG_STORAGE_SOURCES,
  ...NETWORK_SOURCES,
};

/**
 * Where the Overview is cached. A typed source asks the `get_*` its detail
 * page asks, so it reads the page's entry; a manifest is another answer and
 * keeps its own.
 */
export function peekQueryKey(target: PeekTarget): QueryKey {
  const namespace = target.namespace ?? null;
  if (target.crd) {
    return queryKeys.customResource(target.crd, namespace, target.name);
  }
  const resolved = toKind(target.kind);
  return resolved && SOURCES[resolved]
    ? queryKeys.detail(resolved, namespace, target.name)
    : ["peek", resolved ?? target.kind, namespace, target.name];
}

export function resolveSource(target: PeekTarget): PeekSource {
  // A custom resource first, and never by kind: two CRDs may declare the same
  // kind in different groups, and the object being looked at is the one whose
  // CRD the reference named.
  if (target.crd) {
    const custom = customResourceSource(target.crd);
    // The Service's Owns tab names a slice by its group, and the peek it
    // opened lost the line saying the slice has no ports.
    return target.crd === "endpointslices.discovery.k8s.io"
      ? endpointSliceSource(custom, (data) =>
          asObject(data as CustomResourceDetailInfo)
        )
      : custom;
  }
  const resolved = toKind(target.kind);
  const known = resolved ? SOURCES[resolved] : undefined;
  if (!known && target.kind === "EndpointSlice") {
    return endpointSliceSource(manifestSource(target.kind));
  }
  return known ?? manifestSource(resolved ?? target.kind);
}

/**
 * A custom resource, read through the CRD that defines it.
 *
 * Not {@link manifestSource} with a different argument: `getManifest` is given
 * an `apiVersion`, and the only one available for a kind outside the registry
 * is `getApiVersion`'s fallback of `v1` — which asks the core API for an Argo
 * Application and gets a 404, an error panel for every custom resource in the
 * cluster. The backend already resolves a CRD's real group and version from
 * its name, which is what the detail page uses.
 *
 * Without a vendor it reads as the object page reads any object, through
 * `objectFacets`: a peek that understood Argo's `status.health` would be
 * vendor knowledge in the core, which is what the integrations seam exists
 * to prevent. Built-in kinds no screen draws (a Role, an EndpointSlice) are
 * addressed this way too.
 */
function customResourceSource(crdName: string): PeekSource {
  // A kind the vendor tree owns gets the vendor's own reading — the same
  // parser its routing page trusts — in place of the flattened spec. The
  // shell rows stay core either way: what controls it, and its labels.
  const vendor = vendorPeek(crdName);
  return source(
    (name, namespace) => commands.getCustomResource(crdName, name, namespace),
    (resource: CustomResourceDetailInfo, _target, t, kind) => {
      const owners = controlledBy(
        resource.ownerReferences,
        resource.namespace,
        t
      );
      const body = vendor?.(resource, t);
      if (!body) {
        const facets = objectFacets(asObject(resource), t, kind?.hasStatus);
        return { ...facets, groups: [...owners, ...facets.groups] };
      }
      return {
        status:
          body.status ??
          stateOf(resource.status as Record<string, unknown> | null),
        createdAt: resource.createdAt,
        groups: [
          ...owners,
          ...body.groups,
          {
            title: t("columns", "labels"),
            count: Object.keys(resource.labels).length || undefined,
            items: Object.entries(resource.labels)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([label, value]) => ({ label, value, mono: true })),
            emptyMessage: t("empty", "noLabels"),
          },
        ],
      };
    }
  );
}

/** The object a custom-resource read describes, whole again for `objectFacets`. */
function asObject(resource: CustomResourceDetailInfo): Record<string, unknown> {
  return {
    ...resource.fields,
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.name,
      namespace: resource.namespace,
      labels: resource.labels,
      annotations: resource.annotations,
      finalizers: resource.finalizers,
      creationTimestamp: resource.createdAt,
    },
    spec: resource.spec,
    status: resource.status,
  };
}

/**
 * The fallback every kind answers: the object read whole, by the group and
 * plural discovery serves it at, and drawn as the facets the object page
 * draws for the same object.
 */
function manifestSource(kind: string): PeekSource {
  const served = servedOfKind(kind);
  return source(
    async (name, namespace) => {
      if (served)
        return commands.getServedObject(
          served.group,
          served.plural,
          name,
          namespace
        );
      const text = await commands.getManifest(
        kind,
        getApiVersion(kind),
        name,
        namespace
      );
      // Loaded here, not at the top: the YAML parser is the one thing this
      // path needs and no screen at startup does.
      const { load } = await import("js-yaml");
      return load(text);
    },
    (object, _target, t, kind) => objectFacets(object, t, kind?.hasStatus)
  );
}
