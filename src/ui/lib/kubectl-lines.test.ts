import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import { CODE_FILES } from "@/test/source-files";

/** A kubectl or helm line: the tool's name and a word after it. */
const LINE = /\b(kubectl|helm) [a-z]/g;

/**
 * Where the tools are named in words that are not a line to run, each
 * counted. `helm plugin install` puts a plugin on this machine and acts on
 * no cluster; the diagnostics report names the tool and its proxy.
 */
const NAMED_NOT_RUN: Record<string, number> = {
  "src/ui/components/settings/diagnostics/report.ts": 2,
  "src/ui/routes/c/$cluster/-audit/fix-yaml.ts": 1,
};

/** Catalogue sentences that tell what the tools do, and ask nothing run. */
const SAYS_NOT_ASKS = {
  en: [
    "action.copyKubectlGet",
    "action.helmUpgradeCarriesWithheld",
    "action.notThroughKubectlProxy",
    "checks.runsAsExec",
    "audit.removedApiInHelmReleaseWhy",
    "cluster.throughProxy",
    "cluster.throughProxyHint",
    "cluster.proxyNoKubectl",
    "cluster.proxyFailed",
    "cluster.proxyFailedToo",
    "cluster.renewalDelegated",
    "cluster.finishedOnNodeNote",
    "settings.searchToolsWords",
    "settings.pathProxy",
    "settings.pathNoKubectl",
    "settings.kubectlPathNote",
    "empty.drainKeepsAsking",
    "statusMeaning.kubectlPrints",
  ],
  ru: [
    "action.copyKubectlGet",
    "action.notThroughKubectlProxy",
    "checks.runsAsExec",
    "audit.removedApiInHelmReleaseWhy",
    "readings.pdbCannotAllowDetail",
    "readings.pdbBelowFloorDetail",
    "readings.pdbExactlyMetDetail",
    "cluster.throughProxy",
    "cluster.throughProxyHint",
    "cluster.proxyNoKubectl",
    "cluster.proxyFailed",
    "cluster.proxyFailedToo",
    "cluster.finishedOnNodeNote",
    "settings.searchToolsWords",
    "settings.pathProxy",
    "statusMeaning.kubectlPrints",
  ],
};

function linesIn(value: unknown, path: string, found: string[]): string[] {
  if (typeof value === "string") {
    if (new RegExp(LINE.source).test(value)) found.push(path);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value))
      linesIn(inner, path ? `${path}.${key}` : key, found);
  }
  return found;
}

describe("every kubectl or helm line the app hands out", () => {
  /**
   * A line written by hand leaves out the cluster on screen or the files
   * the app read it from, and run in a terminal it answers about another
   * cluster. Fails if code outside `lib/kubectl.ts` writes one: build it
   * with `cliLine`. Comments are not read.
   */
  it("is built by cliLine and nowhere else in code", () => {
    const written: Record<string, number> = {};
    for (const path of CODE_FILES) {
      if (
        path === "src/ui/lib/kubectl.ts" ||
        path.startsWith("src/ui/generated/") ||
        path.startsWith("src/ui/i18n/")
      )
        continue;
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");
      const count = code.match(LINE)?.length ?? 0;
      if (count > 0) written[path] = count;
    }
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(written).toEqual(NAMED_NOT_RUN);
  });

  /**
   * A sentence that asks the reader to run something takes the line as a
   * value built by `cliLine`, `{check}` for instance, never spells it. Fails
   * if a catalogue string names a tool and a word after it and is not one
   * of the sentences above, read and found to ask nothing run.
   */
  it("is never spelled in a catalogue sentence", () => {
    expect(linesIn(en, "", [])).toEqual(SAYS_NOT_ASKS.en);
    expect(linesIn(ru, "", [])).toEqual(SAYS_NOT_ASKS.ru);
  });
});
