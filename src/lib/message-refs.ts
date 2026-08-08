/**
 * What a Kubernetes message says out loud, split into the parts that name
 * something and the prose around them.
 *
 * The whole design is one rule: **the kind must be stated by the controller,
 * never inferred from the token's shape.** A regex over prose invents links
 * that go nowhere, and a dead link is worse than plain text because it claims
 * the cluster has something it does not. So nothing here matches a name; it
 * matches a *sentence a controller writes*, and takes the name out of it.
 *
 * Every anchor below carries the message it was written from, captured from a
 * real cluster (`kubectl get events -A`). None of them were invented — the
 * ones a controller writes differently than you would guess (`Created pod: x`
 * with a colon, `Created job x` without one, `in pod x_ns(uid)`) are exactly
 * why.
 */

import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "./resource-registry";
import { parseImageRef, type ImageReference } from "./image-ref";

export interface ResourceMention {
  kind: string;
  name: string;
  /** `null` for a cluster-scoped kind, and only for one. */
  namespace: string | null;
}

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; ref: ImageReference }
  /** `text` is what was matched, for a caller that declines to link it. */
  | { kind: "resource"; text: string; ref: ResourceMention };

/**
 * The object the message is about: an event's `involvedObject`, or the
 * resource whose condition this is.
 *
 * It does two jobs. Its namespace resolves every name the message states
 * without one — which is nearly all of them, because a controller writes
 * about its own namespace and does not bother to say so. And it is never
 * offered as a link to itself: a pod's own event saying `in pod <this pod>`
 * points at the page you are already reading.
 */
export interface MessageSubject {
  kind?: string | null;
  name?: string | null;
  namespace?: string | null;
}

/** A DNS-1123 subdomain, which is what an object name is allowed to be. */
const NAME = "[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?";
/** A namespace is a DNS-1123 *label*: no dots. */
const NS = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** Which capture group holds what. Groups are 1-based, as in `RegExp`. */
interface Slot {
  kind: string;
  name: number;
  /** The group holding its namespace; the subject's is used when absent. */
  namespace?: number;
}

interface Anchor {
  /** A message from a real cluster. The tests replay these verbatim. */
  example: string;
  pattern: RegExp;
  slots: readonly Slot[];
}

const anchor = (
  example: string,
  source: string,
  slots: readonly Slot[]
): Anchor => ({ example, pattern: new RegExp(source, "g"), slots });

/**
 * Compiled once, at module load. The event feed re-renders hundreds of rows
 * on every poll and segments each message as it goes; building these per
 * render is the one thing that would make that cost anything.
 */
const ANCHORS: readonly Anchor[] = [
  anchor(
    "Scaled up replica set meshed-demo-65d47b457f to 1",
    `\\breplica set (${NAME})`,
    [{ kind: "ReplicaSet", name: 1 }]
  ),
  anchor(
    'ReplicaSet "stuck-demo-5b4cdbdd65" has timed out progressing.',
    `\\bReplicaSet "(${NAME})"`,
    [{ kind: "ReplicaSet", name: 1 }]
  ),
  anchor(
    "Created pod: bare-rs-demo-s64zk",
    `\\b(?:Created|Deleted) pod: (${NAME})`,
    [{ kind: "Pod", name: 1 }]
  ),
  anchor(
    "(combined from similar events): Created job cron-demo-29770275",
    `\\b(?:Created|Deleted) job (${NAME})`,
    [{ kind: "Job", name: 1 }]
  ),
  anchor(
    "Successfully assigned k8s-gui-test/bare-rs-demo-s64zk to k3d-k8s-gui-dev-server-0",
    `\\bSuccessfully assigned (${NS})/(${NAME}) to (${NAME})`,
    [
      { kind: "Pod", name: 2, namespace: 1 },
      { kind: "Node", name: 3 },
    ]
  ),
  // The kubelet's crash-loop line states the pod's namespace inside the
  // parenthesised uid, which is the only place it appears.
  anchor(
    "Back-off restarting failed container app in pod crash-demo-56588f6b8c-8bj9v_k8s-gui-test(1b0d8782-b90b-416e-a74c-cb003238da0d)",
    `\\bin pod (${NAME})_(${NS})\\(`,
    [{ kind: "Pod", name: 1, namespace: 2 }]
  ),
  anchor(
    "create Pod stateful-demo-1 in StatefulSet stateful-demo successful",
    `\\b(?:create|delete) Pod (${NAME}) in StatefulSet (${NAME})\\b`,
    [
      { kind: "Pod", name: 1 },
      { kind: "StatefulSet", name: 2 },
    ]
  ),
  anchor(
    "create Claim data-stateful-demo-1 Pod stateful-demo-1 in StatefulSet stateful-demo success",
    `\\bcreate Claim (${NAME}) Pod (${NAME}) in StatefulSet (${NAME})\\b`,
    [
      { kind: "PersistentVolumeClaim", name: 1 },
      { kind: "Pod", name: 2 },
      { kind: "StatefulSet", name: 3 },
    ]
  ),
  anchor(
    'External provisioner is provisioning volume for claim "k8s-gui-test/data-stateful-demo-1"',
    `\\bfor claim "(${NS})/(${NAME})"`,
    [{ kind: "PersistentVolumeClaim", name: 2, namespace: 1 }]
  ),
  // The apiserver's own not-found text, quoted verbatim by the kubelet. The
  // kind word is the whole reason this is safe: the same message says
  // `for volume "cfg"` two words earlier, and `cfg` is a volume name that
  // exists nowhere in the cluster.
  anchor(
    'MountVolume.SetUp failed for volume "cfg" : configmap "absent-config" not found',
    `\\bconfigmap "(${NAME})" not found`,
    [{ kind: "ConfigMap", name: 1 }]
  ),
  anchor(
    'Error: secret "absent-secret" not found',
    `\\bsecret "(${NAME})" not found`,
    [{ kind: "Secret", name: 1 }]
  ),
];

/** For a test that wants to prove every pattern still reads its own message. */
export const MESSAGE_ANCHOR_EXAMPLES: readonly string[] = ANCHORS.map(
  (entry) => entry.example
);

/**
 * The only image shape trusted in free text: the word `image` (or `images`),
 * whitespace, then a double-quoted reference. Every kubelet message that
 * names one says it this way — `Container image "x" already present on
 * machine`, `Failed to pull image "x"`, `Back-off pulling image "x"`.
 *
 * The quotes are consumed with the match so the renderer owns them; a copy
 * affordance sitting inside the quotation marks reads as part of the string
 * being quoted.
 */
const LABELLED_IMAGE = /\bimages?\s+"([^"\n]+)"/gi;

interface Span {
  start: number;
  end: number;
  segment: MessageSegment;
}

/**
 * Where the group's text sits in the whole message.
 *
 * Found by scanning forward through the match rather than by asking the
 * engine for indices: the groups of every anchor above appear in order, and
 * a forward scan needs no flag the webview might not have.
 */
function locate(match: RegExpExecArray, group: number): number {
  let cursor = 0;
  for (let index = 1; index <= group; index += 1) {
    const value = match[index];
    if (value === undefined) return -1;
    const found = match[0].indexOf(value, cursor);
    if (found === -1) return -1;
    if (index === group) return match.index + found;
    cursor = found + value.length;
  }
  return -1;
}

function sameObject(mention: ResourceMention, subject?: MessageSubject) {
  if (!subject?.name || !subject.kind) return false;
  return (
    subject.name === mention.name &&
    toKind(subject.kind) === toKind(mention.kind) &&
    (subject.namespace ?? null) === mention.namespace
  );
}

/**
 * A cluster-scoped kind has no namespace, and carrying one would put a Node
 * inside a namespace on every message that names one. Whether the result is
 * somewhere the app can actually go is not decided here — `isRoutableKind`
 * is the single authority on that, and it wants the mention as stated.
 */
function scopedNamespace(kind: string, namespace: string | null | undefined) {
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  const namespaced =
    !!resolved && getResourceDefinition(resolved).scope === "namespaced";
  return namespaced ? (namespace ?? null) : null;
}

function imageSpans(message: string): Span[] {
  const spans: Span[] = [];
  LABELLED_IMAGE.lastIndex = 0;
  for (
    let match = LABELLED_IMAGE.exec(message);
    match !== null;
    match = LABELLED_IMAGE.exec(message)
  ) {
    const ref = parseImageRef(match[1]);
    // Labelled but unparseable — an empty pair of quotes, a sentence where
    // the reference should be. Prose is the safe reading.
    if (!ref) continue;
    // The quotes belong to the image segment; the word `image ` before them
    // stays prose.
    const start = match.index + match[0].length - match[1].length - 2;
    spans.push({
      start,
      end: match.index + match[0].length,
      segment: { kind: "image", ref },
    });
  }
  return spans;
}

function resourceSpans(message: string, subject?: MessageSubject): Span[] {
  const spans: Span[] = [];
  for (const { pattern, slots } of ANCHORS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(message);
      match !== null;
      match = pattern.exec(message)
    ) {
      for (const slot of slots) {
        const name = match[slot.name];
        const start = locate(match, slot.name);
        if (!name || start === -1) continue;
        const stated =
          slot.namespace === undefined ? undefined : match[slot.namespace];
        const ref: ResourceMention = {
          kind: slot.kind,
          name,
          namespace: scopedNamespace(slot.kind, stated ?? subject?.namespace),
        };
        // The page you are already on is not somewhere to go.
        if (sameObject(ref, subject)) continue;
        spans.push({
          start,
          end: start + name.length,
          segment: { kind: "resource", text: name, ref },
        });
      }
    }
  }
  return spans;
}

/**
 * The message, split into prose and the things in it you can go to.
 *
 * Overlaps resolve leftmost-first: an image reference and an anchor can both
 * claim a span only in messages neither was written for, and taking the first
 * keeps the result from depending on the order of the table.
 */
export function linkifyMessage(
  message: string,
  subject?: MessageSubject
): MessageSegment[] {
  if (!message) return [];

  const spans = [...imageSpans(message), ...resourceSpans(message, subject)];
  if (spans.length === 0) {
    return [{ kind: "text", text: message }];
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) {
      segments.push({ kind: "text", text: message.slice(cursor, span.start) });
    }
    segments.push(span.segment);
    cursor = span.end;
  }
  if (cursor < message.length) {
    segments.push({ kind: "text", text: message.slice(cursor) });
  }
  return segments;
}
