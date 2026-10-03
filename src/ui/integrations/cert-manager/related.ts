/**
 * What a `Certificate` is connected to — the three things it names and the
 * one thing that names it.
 *
 * A Certificate points *down* at a Secret and *up* at an Issuer, and both are
 * in its own spec. The fourth edge runs backwards and is the one nothing else
 * in the app could draw: what actually *uses* the Secret. That join is the
 * same one `./serves.ts` makes for the page, and it is the difference between
 * "this expires in three days" and "shop.example.com stops working in three
 * days" — see that file for what it deliberately cannot see.
 */

import { commands } from "@/lib/commands";
import type { IngressInfo } from "@/generated/types";
import type { RelatedObject } from "../registry";
import { certificateUse } from "./serves";

const GROUP = "cert-manager.io";

/** The kinds whose relations are in their own spec, so one read answers. */
const OWNED = new Set(["Certificate"]);

/**
 * `getValueByPath` walks a whole resource; a spec is one level in and comes
 * back typed `unknown`, so these two read it directly rather than making the
 * shared helper accept anything.
 */
const at = (spec: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    spec
  );

const text = (spec: unknown, ...path: string[]): string | null => {
  const value = at(spec, ...path);
  return typeof value === "string" && value ? value : null;
};

const list = (spec: unknown, ...path: string[]): string[] => {
  const value = at(spec, ...path);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

export async function relatedTo(subject: {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}): Promise<RelatedObject[] | null> {
  // `null` and not `[]`: cert-manager owns six kinds and every other CRD on
  // the cluster belongs to somebody else.
  if (subject.group !== GROUP || !OWNED.has(subject.kind)) return null;

  const resource = await commands.getCustomResource(
    `${subject.kind.toLowerCase()}s.${GROUP}`,
    subject.name,
    subject.namespace
  );
  const spec = resource.spec;
  // A Certificate is namespaced, so the API server never hands one back
  // without a namespace; the type allows null because the same shape carries
  // cluster-scoped kinds too.
  const namespace = resource.namespace ?? subject.namespace ?? "";

  const related: RelatedObject[] = [];

  const issuerName = text(spec, "issuerRef", "name");
  if (issuerName) {
    const issuerKind = text(spec, "issuerRef", "kind") ?? "Issuer";
    related.push({
      relation: "relIssuedBy",
      kind: issuerKind,
      name: issuerName,
      // A ClusterIssuer is cluster-scoped, and addressing it inside the
      // Certificate's namespace would be a link to nothing.
      namespace: issuerKind === "ClusterIssuer" ? null : namespace,
      group: GROUP,
    });
  }

  const secretName = text(spec, "secretName");
  if (secretName) {
    related.push({
      relation: "relIssuesInto",
      kind: "Secret",
      name: secretName,
      namespace,
      group: "",
    });

    // The backwards edge. A failure here costs these rows and nothing else:
    // the two above are in the object already.
    const ingresses = await commands
      .listIngresses(null)
      .catch((): IngressInfo[] => []);
    const use = certificateUse(
      { secretName, namespace, dnsNames: list(spec, "dnsNames") },
      ingresses,
      // The page's own rule: only a cluster with no routing CRDs at all may
      // be told a certificate is used by nothing, and this file cannot know
      // that. Left false, nothing here claims it is unused — the rows simply
      // say what was found.
      { unusedIsCertain: false }
    );
    for (const host of use.hosts) {
      related.push({
        relation: host.covered ? "relServing" : "relMountedNotCovering",
        kind: "Ingress",
        name: host.ingress.name,
        namespace: host.ingress.namespace,
        group: "networking.k8s.io",
        note: host.host,
        // Not a guess at health: an Ingress serving a hostname this
        // certificate's names do not reach is a browser error today, and the
        // Ingress, the Secret and the Certificate all read as fine.
        tone: host.covered ? undefined : "err",
      });
    }
  }

  return related;
}
