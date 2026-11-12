import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const en: T = (section, key, values) => translate("en", section, key, values);

/**
 * The generic list of Applications draws `repoURL` in a column, one more
 * reader of the address the page and the file already cut. Fails if the
 * column prints the token a remote is cloned with.
 */
describe("the repository column of the Application list", () => {
  it("names the host and path and not the credentials before them", () => {
    const column = crd
      .columnsFor("Application")
      .find((one) => one.id === "repo")!;
    const resource = {
      spec: {
        source: {
          repoURL:
            "https://oauth2:glpat-" +
            "AbCdEf0123456789xyzQ@gitlab.example.com/org/repo.git",
        },
      },
    } as unknown as CustomResourceInfo;
    expect(column.cell!(column.accessor(resource, en), en)).toBe(
      "…@gitlab.example.com/org/repo.git"
    );
  });
});

/**
 * One more reader of whether auto-sync is on. Fails if the column says "on"
 * for an Application whose automated sync Argo CD 3.1 was told to skip.
 */
describe("the autoSync column of the Application list", () => {
  const column = crd
    .columnsFor("Application")
    .find((one) => one.id === "autoSync")!;
  const says = (automated: unknown) =>
    column.cell!(
      column.accessor(
        {
          spec: { syncPolicy: { automated } },
        } as unknown as CustomResourceInfo,
        en
      ),
      en
    );

  it("says off where automated sync is disabled", () => {
    expect(says({ enabled: false, selfHeal: true })).toBe("off");
    expect(says(undefined)).toBe("off");
  });

  it("says on where it is declared and not disabled", () => {
    expect(says({})).toBe("on");
  });
});
