/**
 * Who owns this object — all the way up, not one hop.
 *
 * An owner reference is one fact — "a ReplicaSet made this pod" — so it reads
 * as a metadata row like every other fact on the page. It used to be a
 * bordered, hoverable box with the kind floated right in a pill, which made
 * the least surprising thing on a pod page the only elevated one.
 *
 * One hop is also rarely the answer anyone wants. A pod's owner is a hash
 * nobody named, and the object the reader is actually looking for is one
 * further up: `meshed-demo-65d47b457f` is a revision, `meshed-demo` is the
 * Deployment somebody deploys. The chain is walked until something owns
 * nothing, so both are on the page and both are somewhere you can go.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { commands } from "@/lib/commands";
import { replicaSetter, replicaSetterWords } from "@/lib/connections";
import { isScalable } from "@/lib/resource-registry";
import { isBuiltInGroup } from "@/lib/links";
import { groupOf } from "@/hooks/useCrdIndex";
import { OwnerRef } from "../../-peek/OwnerRef";
import { KeyValueRow } from "../../-object/detail-kv";
import type { OwnerReference, ResourceConnections } from "@/generated/types";
import { useT } from "@/i18n/useT";

interface RelatedResourcesProps {
  ownerReferences: OwnerReference[];
  namespace?: string;
  /** The page's neighbourhood, which names the autoscaler that sets the count, if any. */
  connections?: ResourceConnections;
}

/** One hop up: what owns the thing below it, with the group that says which kind it is. */
type Hop = Pick<OwnerReference, "api_version" | "kind" | "name">;

/** Whether an owner is the built-in of its kind's name, not a custom kind that shares it. */
const isBuiltIn = (hop: Hop) =>
  isBuiltInGroup(hop.kind, groupOf(hop.api_version));

/**
 * The kinds whose own owner can be read back.
 *
 * Only the controllers that are themselves owned appear here: a Deployment is
 * owned by nothing in an ordinary cluster, so fetching it to find out would
 * be a request whose answer is always empty. A kind that is missing simply
 * ends the chain, which is the same thing the chain does when it reaches the
 * top — so a new kind costs a line here and breaks nothing by being absent.
 */
const OWNER_OF: Record<
  string,
  (
    name: string,
    namespace: string
  ) => Promise<{
    ownerReferences: OwnerReference[];
  }>
> = {
  ReplicaSet: commands.getReplicaset,
  Job: commands.getJob,
};

/** The controller, or the first owner where nothing claims to control. */
function controllerOf(owners: OwnerReference[] | undefined): Hop | null {
  if (!owners?.length) return null;
  return owners.find((entry) => entry.controller) ?? owners[0];
}

/**
 * Every hop above `start`, in order.
 *
 * Bounded twice over: by a depth cap and by the set of names already seen. An
 * owner cycle is not supposed to exist, but it is a thing a hand-written
 * `ownerReferences` can produce, and an unbounded walk over one is a request
 * loop against the API server rather than a rendering bug.
 */
async function walkUp(start: Hop, namespace: string): Promise<Hop[]> {
  const hops: Hop[] = [];
  const seen = new Set<string>();
  let current: Hop | null = start;

  while (current && hops.length < 4) {
    const key = `${current.api_version}/${current.kind}/${current.name}`;
    if (seen.has(key)) break;
    seen.add(key);
    hops.push(current);

    const fetchOwner = isBuiltIn(current) ? OWNER_OF[current.kind] : undefined;
    if (!fetchOwner) break;
    try {
      const parent = await fetchOwner(current.name, namespace);
      current = controllerOf(parent.ownerReferences);
    } catch {
      // The hop is unreadable with this access, or gone. What we already
      // have is still true, and is better than dropping the whole chain.
      break;
    }
  }

  return hops;
}

export function RelatedResources({
  ownerReferences,
  namespace,
  connections,
}: RelatedResourcesProps) {
  const t = useT();
  const controller = controllerOf(ownerReferences?.filter((r) => r.controller));
  const others = (ownerReferences ?? []).filter((ref) => !ref.controller);

  const { data: chain } = useQuery({
    queryKey: [
      "owner-chain",
      namespace,
      controller?.api_version,
      controller?.kind,
      controller?.name,
    ],
    queryFn: () => walkUp(controller!, namespace!),
    enabled: !!controller && !!namespace,
    staleTime: 60_000,
  });

  if (!ownerReferences || ownerReferences.length === 0) {
    return null;
  }

  // Until the walk answers, the hop the object itself stated is already
  // known — showing it and growing the chain beats an empty row that fills
  // in a moment later.
  const hops = chain ?? (controller ? [controller] : []);
  const top = hops[hops.length - 1];
  const setter =
    top && connections && isBuiltIn(top) && isScalable(top.kind)
      ? replicaSetterWords(
          replicaSetter(connections, { ...top, namespace: namespace ?? null }),
          t
        )
      : null;

  return (
    <Section>
      <SectionHeader title={t("nav", "relatedResources")} />
      <dl className="flex flex-col">
        {hops.length > 0 && (
          <KeyValueRow label={t("columns", "controlledBy")}>
            <span className="flex flex-wrap items-baseline gap-x-2">
              {hops.map((hop, index) => (
                <span
                  key={`${hop.api_version}/${hop.kind}/${hop.name}`}
                  className="inline-flex items-baseline gap-x-2"
                >
                  {index > 0 && (
                    // Reads "…which is controlled by". Faint and small: it is
                    // punctuation between two references, not a third thing.
                    <ChevronRight
                      className="h-2.5 w-2.5 self-center text-fg-fnt"
                      aria-hidden="true"
                    />
                  )}
                  <OwnerName hop={hop} namespace={namespace} />
                </span>
              ))}
              {/* Unsaid until the neighbourhood answers: only it knows whether
                  an autoscaler sets the count instead. */}
              {setter && (
                <span className="text-[11px] text-fg-fnt">{setter}</span>
              )}
            </span>
          </KeyValueRow>
        )}
        {others.map((owner) => (
          <KeyValueRow key={owner.uid} label={t("columns", "ownedBy")}>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <OwnerName hop={owner} namespace={namespace} />
            </span>
          </KeyValueRow>
        ))}
      </dl>
    </Section>
  );
}

function OwnerName({ hop, namespace }: { hop: Hop; namespace?: string }) {
  return (
    <span className="inline-flex items-baseline gap-x-2">
      <OwnerRef owner={hop} namespace={namespace ?? null} />
      {/* The kind qualifies the name. It is not a state, so it is quiet
       *  text rather than a badge. */}
      <span className="text-[11px] text-fg-fnt">{hop.kind}</span>
    </span>
  );
}
