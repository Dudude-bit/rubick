import { createElement, Fragment, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const en: T = (section, key, values) => translate("en", section, key, values);

/** What the list's Ready cell says for an object with these conditions. */
function ready(kind: string, conditions: unknown): string | null {
  const column = crd.columnsFor(kind).find((one) => one.id === "ready")!;
  const resource = { status: { conditions } } as CustomResourceInfo;
  const node = column.cell!(column.accessor(resource, en), en);
  return render(createElement(Fragment, null, node as ReactNode)).container
    .textContent;
}

describe("the Ready column of Flux's Helm lists", () => {
  /**
   * `status === "True" ? "True" : "False"` printed "False" for an object
   * Flux was still reconciling (`Unknown`) and for one it had not written a
   * Ready condition on yet, so work in progress read as failed.
   */
  it.each(["HelmRelease", "HelmRepository", "HelmChart"])(
    "says a %s's Ready as Flux wrote it, and never False for one it did not",
    (kind) => {
      expect(ready(kind, [{ type: "Ready", status: "True" }])).toBe("True");
      expect(ready(kind, [{ type: "Ready", status: "False" }])).toBe("False");
      expect(ready(kind, [{ type: "Ready", status: "Unknown" }])).toBe(
        "Unknown"
      );
      expect(ready(kind, [{ type: "Reconciling", status: "True" }])).toBe(
        "not written yet"
      );
      expect(ready(kind, undefined)).toBe("not written yet");
    }
  );

  /** Flux's own reason for a reconcile under way is kept as the word. */
  it("keeps Progressing for a HelmRelease that is reconciling", () => {
    const progressing = { type: "Ready", reason: "Progressing" };
    expect(ready("HelmRelease", [{ ...progressing, status: "Unknown" }])).toBe(
      "Progressing"
    );
    expect(ready("HelmRelease", [{ ...progressing, status: "True" }])).toBe(
      "True"
    );
  });
});

describe("the chart column of the HelmRelease list", () => {
  /** A release that names its chart through `chartRef` has no chart template, and its row said "none". */
  it("names the chart a release refers to where it has no chart template", () => {
    const column = crd
      .columnsFor("HelmRelease")
      .find((one) => one.id === "chart")!;
    const referring = {
      spec: { chartRef: { kind: "OCIRepository", name: "podinfo" } },
    } as unknown as CustomResourceInfo;
    expect(column.accessor(referring, en)).toBe("podinfo");
  });
});
