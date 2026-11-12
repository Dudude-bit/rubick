import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";

import { eventsUidIn } from "./useReadUid";

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/events-uid-conformance.json"),
    "utf8"
  )
) as { cases: { name: string; pod: unknown; uid: string | null }[] };

/**
 * `src/contracts/events-uid-conformance.json` is what makes this and the
 * backend's `events_uid` one answer. Fails if a static pod's events are
 * matched against its mirror's uid, under which the kubelet writes none.
 */
it.each(corpus.cases)("$name", ({ pod, uid }) => {
  expect(eventsUidIn("Pod", pod) ?? null).toBe(uid);
});

/** A typed read and the metadata read carry the annotations beside the uid. Fails if only the manifest's shape is read. */
it("reads the hash from a typed read as from a manifest", () => {
  const typed = {
    uid: "9f0c2a11",
    annotations: { "kubernetes.io/config.mirror": "5f3c0d7e" },
  };
  expect(eventsUidIn("Pod", typed)).toBe("5f3c0d7e");
});

/** Only the kubelet writes events under that hash, and only about pods. Fails if another kind carrying the annotation loses its own uid. */
it("leaves every other kind its own uid", () => {
  const copied = {
    uid: "9f0c2a11",
    annotations: { "kubernetes.io/config.mirror": "5f3c0d7e" },
  };
  expect(eventsUidIn("Deployment", copied)).toBe("9f0c2a11");
});
