import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { AksPicture } from "./data";
import { AZURE_IDENTITY_CRD } from "./model";
import { danglingSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

const object = (kind: string, name: string, spec: unknown) =>
  ({
    name,
    namespace: "shop",
    kind,
    spec,
    status: null,
  }) as unknown as CustomResourceInfo;

const binding = object("AzureIdentityBinding", "web-binding", {
  azureIdentity: "web-id",
  selector: "web",
});

const picture = (over: Partial<AksPicture> = {}): AksPicture =>
  ({
    identities: [],
    bindings: [binding],
    prohibited: [],
    legacyInstalled: true,
    workload: { accounts: [], findings: [] },
    podsKnown: true,
    unread: [],
    ...over,
  }) as unknown as AksPicture;

describe("what the AKS add-ons screen tells Share about dangling bindings", () => {
  /** The whole picture refused came out as no section: "no binding dangles". */
  it("marks the section unread when the picture could not be read", () => {
    expect(
      danglingSection(undefined, new Error("forbidden"), t)?.unread
    ).toContain("forbidden");
  });

  it("marks the section unread while the picture is still loading", () => {
    expect(danglingSection(undefined, null, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  /** A refused AzureIdentity list is an empty one to `danglingBindings`, so
   *  every binding would have been reported as naming a missing identity. */
  it("marks the section unread, not every binding dangling, when identities were refused", () => {
    const section = danglingSection(
      picture({ unread: [{ what: AZURE_IDENTITY_CRD, reason: "forbidden" }] }),
      null,
      t
    );
    expect(section?.unread).toContain("forbidden");
    expect(section?.count).toBeNull();
  });

  it("reports a binding whose identity was read and is not there", () => {
    const section = danglingSection(picture(), null, t);
    expect(section?.unread).toBeUndefined();
    expect(section?.count).toBe(1);
  });

  it("reports nothing when every binding's identity exists", () => {
    expect(
      danglingSection(
        picture({ identities: [object("AzureIdentity", "web-id", {})] }),
        null,
        t
      )
    ).toBeNull();
  });
});
