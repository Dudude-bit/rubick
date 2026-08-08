import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  linkifyMessage,
  MESSAGE_ANCHOR_EXAMPLES,
  type MessageSegment,
  type MessageSubject,
} from "./message-refs";

/**
 * Every message below was taken off a running cluster with
 * `kubectl get events -A` — none were written from memory. The point of the
 * table is that a controller's wording is not what you would guess: `Created
 * pod: x` has a colon, `Created job x` does not, and the crash-loop line
 * hides the pod's namespace inside a parenthesised uid.
 */
const POD = { kind: "Pod", name: "some-pod", namespace: "k8s-gui-test" };
const IN_TEST_NS: MessageSubject = { namespace: "k8s-gui-test" };

/** `text|[Kind ns/name]|text`, so a case reads as the sentence it is. */
const render = (segments: MessageSegment[]) =>
  segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      if (segment.kind === "image") return `<${segment.ref.reference}>`;
      const { kind, name, namespace } = segment.ref;
      return `[${kind} ${namespace ?? "-"}/${name}]`;
    })
    .join("");

describe("linkifyMessage", () => {
  /**
   * The controller states the kind, so the name beside it is an object. If a
   * wording changes and one of these silently stops matching, the event that
   * scaled a replica set goes back to being dead text.
   */
  it.each([
    [
      "Scaled up replica set meshed-demo-65d47b457f to 1",
      "Scaled up replica set [ReplicaSet k8s-gui-test/meshed-demo-65d47b457f] to 1",
    ],
    [
      "Scaled down replica set meshed-demo-65d47b457f to 0 from 1",
      "Scaled down replica set [ReplicaSet k8s-gui-test/meshed-demo-65d47b457f] to 0 from 1",
    ],
    [
      'ReplicaSet "stuck-demo-5b4cdbdd65" has timed out progressing.',
      'ReplicaSet "[ReplicaSet k8s-gui-test/stuck-demo-5b4cdbdd65]" has timed out progressing.',
    ],
    [
      "Created pod: bare-rs-demo-s64zk",
      "Created pod: [Pod k8s-gui-test/bare-rs-demo-s64zk]",
    ],
    [
      "Deleted pod: meshed-demo-65d47b457f-dnp7g",
      "Deleted pod: [Pod k8s-gui-test/meshed-demo-65d47b457f-dnp7g]",
    ],
    [
      "(combined from similar events): Created job cron-demo-29770275",
      "(combined from similar events): Created job [Job k8s-gui-test/cron-demo-29770275]",
    ],
    [
      "create Pod stateful-demo-1 in StatefulSet stateful-demo successful",
      "create Pod [Pod k8s-gui-test/stateful-demo-1] in StatefulSet [StatefulSet k8s-gui-test/stateful-demo] successful",
    ],
    [
      "create Claim data-stateful-demo-1 Pod stateful-demo-1 in StatefulSet stateful-demo success",
      "create Claim [PersistentVolumeClaim k8s-gui-test/data-stateful-demo-1] Pod [Pod k8s-gui-test/stateful-demo-1] in StatefulSet [StatefulSet k8s-gui-test/stateful-demo] success",
    ],
    [
      'External provisioner is provisioning volume for claim "k8s-gui-test/data-stateful-demo-1"',
      'External provisioner is provisioning volume for claim "k8s-gui-test/[PersistentVolumeClaim k8s-gui-test/data-stateful-demo-1]"',
    ],
    [
      'Error: secret "absent-secret" not found',
      'Error: secret "[Secret k8s-gui-test/absent-secret]" not found',
    ],
  ])("reads the kind out of %j", (message, expected) => {
    expect(render(linkifyMessage(message, IN_TEST_NS))).toBe(expected);
  });

  /**
   * The same sentence names a volume and a ConfigMap in the same shape. Only
   * the one the message calls a configmap is an object; `cfg` is a name that
   * exists nowhere in the cluster, and linking it would claim otherwise.
   */
  it("links the kind that is stated and not the one beside it", () => {
    expect(
      render(
        linkifyMessage(
          'MountVolume.SetUp failed for volume "cfg" : configmap "absent-config" not found',
          IN_TEST_NS
        )
      )
    ).toBe(
      'MountVolume.SetUp failed for volume "cfg" : configmap "[ConfigMap k8s-gui-test/absent-config]" not found'
    );
  });

  /**
   * These name nothing, or name something whose kind is never stated. Any one
   * of them turning into a link is the failure this whole feature has: a link
   * that goes nowhere reads as a promise the cluster never made.
   */
  it.each([
    "Created container app",
    "Started container cron",
    "Stopping container proxy",
    "Job completed",
    "Error: ErrImagePull",
    "Error: ImagePullBackOff",
    "Deployment does not have minimum availability.",
    "waiting for first consumer to be created before binding",
    "Successfully provisioned volume pvc-87a7a9d4-4c56-49ef-a220-93cca4e158ac",
    "0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.",
    "(combined from similar events): Failed to garbage collect required amount of images. Attempted to free 17318182912 bytes, but only found 0 bytes eligible to free.",
    "Readiness probe failed: HTTP probe failed with statuscode: 503",
    "Liveness probe failed: dial tcp 10.42.0.6:8080: connect: connection refused",
    "Successfully pulled image in 1.2s",
  ])("leaves %j exactly as it is", (message) => {
    expect(linkifyMessage(message, IN_TEST_NS)).toEqual([
      { kind: "text", text: message },
    ]);
  });

  /**
   * A message that states its own namespace overrides the subject's, and a
   * cluster-scoped kind gets none at all. Getting this wrong sends every link
   * on the all-namespaces event feed to the wrong place.
   */
  it("prefers the namespace the message states", () => {
    expect(
      render(
        linkifyMessage(
          "Successfully assigned other-ns/bare-rs-demo-s64zk to k3d-k8s-gui-dev-server-0",
          IN_TEST_NS
        )
      )
    ).toBe(
      "Successfully assigned other-ns/[Pod other-ns/bare-rs-demo-s64zk] to [Node -/k3d-k8s-gui-dev-server-0]"
    );
    expect(
      render(
        linkifyMessage(
          "Back-off restarting failed container app in pod crash-demo-56588f6b8c-8bj9v_other-ns(1b0d8782-b90b-416e-a74c-cb003238da0d)",
          IN_TEST_NS
        )
      )
    ).toBe(
      "Back-off restarting failed container app in pod [Pod other-ns/crash-demo-56588f6b8c-8bj9v]_other-ns(1b0d8782-b90b-416e-a74c-cb003238da0d)"
    );
  });

  /**
   * The pod's own crash-loop event names the pod whose page you are reading.
   * Offering it is a link to here.
   */
  it("does not offer the object the message is about", () => {
    const message =
      "Back-off restarting failed container app in pod some-pod_k8s-gui-test(1b0d8782)";
    expect(linkifyMessage(message, POD)).toEqual([
      { kind: "text", text: message },
    ]);
    // The same message on any other object still offers it.
    expect(
      render(linkifyMessage(message, { ...POD, name: "another-pod" }))
    ).toContain("[Pod k8s-gui-test/some-pod]");
  });

  /** The image segments this segmenter inherited must survive the second
   *  kind of segment arriving beside them. */
  it("still finds the images the message labels", () => {
    expect(
      render(
        linkifyMessage(
          'Container image "busybox:1.36" already present on machine',
          IN_TEST_NS
        )
      )
    ).toBe("Container image <busybox:1.36> already present on machine");
    expect(
      render(
        linkifyMessage('Back-off pulling image "registry.invalid/nope:v9"')
      )
    ).toBe("Back-off pulling image <registry.invalid/nope:v9>");
    // Quoted, image-shaped, and labelled a container: still prose.
    expect(linkifyMessage('Created container "busybox"')).toEqual([
      { kind: "text", text: 'Created container "busybox"' },
    ]);
  });

  it("returns nothing for an empty message", () => {
    expect(linkifyMessage("")).toEqual([]);
  });

  /**
   * A pattern nobody's wording matches any more is a pattern that silently
   * does nothing. Each one carries the message it was written from, and has
   * to still read it.
   */
  it("every pattern still reads the message it was written from", () => {
    for (const example of MESSAGE_ANCHOR_EXAMPLES) {
      const found = linkifyMessage(example, IN_TEST_NS).filter(
        (segment) => segment.kind === "resource"
      );
      expect(found.length, example).toBeGreaterThan(0);
    }
  });
});

/**
 * A log line is text the app does not own, and YAML is a document you read as
 * written. Either one linkified would be a claim about the cluster that the
 * cluster never made — so neither surface is allowed to reach the segmenter,
 * and this is the check rather than a review comment.
 */
describe("surfaces that must stay text", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sources(path) : [path];
    });

  it.each(["src/components/logs", "src/components/yaml"])(
    "%s never imports the segmenter",
    (dir) => {
      const offenders = sources(dir).filter((path) =>
        /message-refs|ResourceMessage/.test(readFileSync(path, "utf8"))
      );
      expect(offenders).toEqual([]);
    }
  );
});
