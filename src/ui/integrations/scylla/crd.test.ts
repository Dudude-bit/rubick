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

const members = (status: unknown) => {
  const column = crd
    .columnsFor("ScyllaCluster")
    .find((one) => one.id === "members");
  const cluster = { spec: {}, status } as CustomResourceInfo;
  return drawn(column?.cell?.(column.accessor(cluster, en), en));
};

describe("the members column of the ScyllaCluster list", () => {
  /**
   * The count is the operator's to write. Drawn as "none", a cluster it
   * had not reconciled read as one with no members, beside a page that says
   * the count is not written. Fails if an unwritten status is "none" again.
   */
  it("says not written yet for a cluster the operator has written no status on", () => {
    expect(members(null)).toBe("not written yet");
    expect(members({})).toBe("not written yet");
    expect(members({ members: 3, readyMembers: 2 })).toBe("2/3");
  });
});
