import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "./source-files";

/** A left rule that marks a row, a nav item or a form block, not a notice. */
const NOT_NOTICES = new Set([
  "src/ui/components/settings/SettingsNav.tsx",
  "src/ui/routes/c/$cluster/events/-components/StoryCard.tsx",
  "src/ui/routes/c/$cluster/-object/AutoscalerBounds.tsx",
]);

describe("notices", () => {
  /**
   * A left-ruled block was a fifth notice look beside Alert and Unknown. Fails
   * if a file outside the three rows and forms above draws one again.
   */
  it("are drawn by Alert or Unknown, never as a left-ruled block", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const ruled = CODE_FILES.filter(
      (path) =>
        !NOT_NOTICES.has(path) &&
        /\bborder-l-2\b/.test(readFileSync(join(root, path), "utf8"))
    );
    expect(ruled).toEqual([]);
  });
});
