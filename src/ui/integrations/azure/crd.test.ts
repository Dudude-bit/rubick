// @vitest-environment jsdom
import { createElement, Fragment, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const en: T = (section, key, values) => translate("en", section, key, values);

const drawn = (node: unknown) =>
  render(createElement(Fragment, null, node as ReactNode)).container
    .textContent;

const status = (written: unknown) => {
  const column = crd
    .columnsFor("AzureAssignedIdentity")
    .find((one) => one.id === "status");
  const assigned = { spec: {}, status: written } as CustomResourceInfo;
  return drawn(column?.cell?.(column.accessor(assigned, en), en));
};

describe("the status column of the AzureAssignedIdentity list", () => {
  /**
   * `status.status` is the add-on's to write. Drawn as "none", an
   * assignment it had not processed read as one with no status at all.
   * Fails if an unwritten status is "none" again.
   */
  it("says not written yet for an assignment the add-on has not answered about", () => {
    expect(status(null)).toBe("not written yet");
    expect(status({ status: "Assigned" })).toBe("Assigned");
  });
});
