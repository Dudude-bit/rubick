import { describe, expect, it } from "vite-plus/test";

import type { OwnerReference } from "@/generated/types";
import { controlledBy } from "./controlled-by";

const pod = (name: string, uid: string) => ({
  name,
  ownerReferences: [
    {
      api_version: "apps/v1",
      kind: "StatefulSet",
      name: "web",
      uid,
      controller: true,
    } satisfies OwnerReference,
  ],
});

describe("the pods a workload controls", () => {
  /**
   * A StatefulSet deleted and made again under its name: the old web-0,
   * still terminating, carries its labels and its name, and its page listed
   * it as the new one's. Fails if a pod is matched by name or labels rather
   * than by its controller's uid.
   */
  it("keeps only the pods whose controller is the workload by uid", () => {
    const old = pod("web-0", "web-deleted");
    const own = pod("web-1", "web-now");
    expect(controlledBy([old, own], "web-now")).toEqual([own]);
  });

  /** Before the workload is read there is no uid to match, and nothing is dropped. */
  it("keeps every pod while the workload's uid is not read", () => {
    const pods = [pod("web-0", "web-deleted")];
    expect(controlledBy(pods, undefined)).toBe(pods);
  });
});
