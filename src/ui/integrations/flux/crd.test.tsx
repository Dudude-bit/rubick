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

/**
 * The generic list of HelmRepository objects draws `spec.url` in a column,
 * a third reader of the address the page and the file already cut. Fails
 * if the column prints what stands before the host.
 */
describe("the URL column of Flux's HelmRepository list", () => {
  it("names the host and path and not the credentials before them", () => {
    const column = crd
      .columnsFor("HelmRepository")
      .find((one) => one.id === "url")!;
    const resource = {
      spec: { url: "https://ci:S3cret@charts.example.com/stable" },
    } as unknown as CustomResourceInfo;
    expect(column.cell!(column.accessor(resource, en), en)).toBe(
      "https://…@charts.example.com/stable"
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

describe("the status columns of an OCI HelmRepository", () => {
  const cell = (id: string, resource: unknown) => {
    const column = crd
      .columnsFor("HelmRepository")
      .find((one) => one.id === id)!;
    const node = column.cell!(
      column.accessor(resource as CustomResourceInfo, en),
      en
    );
    return render(createElement(Fragment, null, node as ReactNode)).container
      .textContent;
  };
  const oci = { spec: { type: "oci", url: "oci://ghcr.io/acme/charts" } };

  /**
   * Flux writes no status on one, ever. "not written yet" under Ready and
   * Last fetched promised a value that does not come. Fails if either
   * column says "yet" of an OCI repository.
   */
  it("says OCI address, not that a status is still to be written", () => {
    expect(cell("ready", oci)).toBe("OCI address");
    expect(cell("artifact", oci)).toBe("OCI address");
  });

  /** The control: an ordinary repository with no status is still pending. */
  it("still says not written yet for an HTTP repository with no status", () => {
    const http = { spec: { url: "https://charts.example.com" } };
    expect(cell("ready", http)).toBe("not written yet");
    expect(cell("artifact", http)).toBe("not written yet");
  });
});
