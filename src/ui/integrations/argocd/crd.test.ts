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
