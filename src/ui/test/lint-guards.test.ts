import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const VIOLATIONS: Record<string, string> = {
  "no-refetch-interval": `export const q = { refetchInterval: 1000 };`,
  "no-raw-colour": `export const c = "flex bg-red-500";`,
  "no-theme-branch": `export const c = "dark:bg-canvas";`,
  "no-legacy-token": `export const c = "text-muted-foreground";`,
  "no-vendor-import": `export { x } from "@/integrations/cert-manager";`,
  "status-is-a-code": `export const b = <Badge status={t("ready")} />;`,
  "no-native-select": `export const s = <select />;`,
};

const CLEAN = `
import { useCapability } from "@/integrations";
export const c = "bg-canvas text-fg-mut border-hair";
export const b = <Badge status={code}>{t("ready")}</Badge>;
export const s = <Select />;
`;

interface Diagnostic {
  code: string;
  severity: string;
  filename: string;
}

let dir: string;
let found: Diagnostic[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rubick-lint-"));
  for (const [rule, code] of Object.entries(VIOLATIONS))
    writeFileSync(join(dir, `${rule}.tsx`), code);
  writeFileSync(join(dir, "clean.tsx"), CLEAN);
  const run = spawnSync(
    "node_modules/.bin/vp",
    ["lint", "-f", "json", "--threads=2", dir],
    { encoding: "utf8" }
  );
  found = (JSON.parse(run.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rubickIn = (file: string) =>
  found
    .filter((d) => d.filename.endsWith(`/${file}`))
    .filter((d) => d.code.startsWith("rubick("));

describe("the project's own lint guards", () => {
  /**
   * The guards live in a local plugin the config has to load and switch on
   * by name; a rule dropped from the config fails nothing and guards nothing.
   */
  it.each(Object.keys(VIOLATIONS))("refuse %s as an error", (rule) => {
    expect(rubickIn(`${rule}.tsx`)).toContainEqual(
      expect.objectContaining({ code: `rubick(${rule})`, severity: "error" })
    );
  });

  /** A pattern that also matched role tokens would be switched off within a day. */
  it("pass the code they point people to", () => {
    expect(rubickIn("clean.tsx")).toEqual([]);
  });
});
