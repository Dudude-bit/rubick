import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { rowNouns } from "@/lib/resource-registry";
import { CODE_FILES } from "@/test/source-files";

describe("a count in words", () => {
  /**
   * `${n} path${n === 1 ? "" : "s"}` has no whole string for a scanner to
   * find, and Russian has three forms, so it survived every sweep: three
   * routing maps and the tool-path hint printed English on a Russian screen.
   */
  it("comes from a catalogue plural, never an English 's' added in code", () => {
    const composed = CODE_FILES.filter(
      (path) => !path.startsWith("src/ui/i18n/")
    ).filter((path) =>
      /[=!]== 1 \? "s?" : "s?"|> 1 \? "s" : ""/.test(readFileSync(path, "utf8"))
    );
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(composed).toEqual([]);
  });

  /**
   * A list footer and its namespace headers built "{n} {noun}" by hand, so a
   * Russian screen read "1 endpoints" and "25 deployments". The count goes
   * through `readings.objectCount` with `rowNouns`.
   */
  it("never picks a list's noun by the number in code", () => {
    const composed = CODE_FILES.filter(
      (path) => !path.endsWith("/resource-registry.ts")
    ).filter((path) =>
      /=== 1 \? toSingularNoun\(/.test(readFileSync(path, "utf8"))
    );
    expect(composed).toEqual([]);
  });

  /** One of every form, with the kind named as the sidebar names it. */
  it("counts a list's rows with the form the number takes", () => {
    const say = (locale: "en" | "ru", label: string, n: number) =>
      translate(locale, "readings", "objectCount", rowNouns(label, n));
    expect(say("en", "deployments", 1)).toBe("1 Deployment");
    expect(say("en", "endpoints", 25)).toBe("25 Endpoints");
    expect(say("en", "pvcs", 2)).toBe("2 PVCs");
    expect(say("ru", "endpoints", 1)).toBe("1 объект Endpoints");
    expect(say("ru", "services", 3)).toBe("3 объекта Service");
    expect(say("ru", "deployments", 25)).toBe("25 объектов Deployment");
    expect(say("ru", "persistent volumes", 21)).toBe(
      "21 объект PersistentVolume"
    );
  });
});
