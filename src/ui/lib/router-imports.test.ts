import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODE_FILES, SOURCE_FILES } from "@/test/source-files";

describe("the router the app runs on", () => {
  /**
   * A component importing the old router renders under TanStack's provider
   * and throws "useNavigate() may be used only in the context of a <Router>"
   * at the first click, with every test that mocks it still green.
   */
  it("is imported from TanStack only", () => {
    const files = SOURCE_FILES.filter((path) => /\.tsx?$/.test(path));
    expect(files.length).toBeGreaterThan(CODE_FILES.length);
    const stale = files.filter((path) =>
      /from "react-router(-dom)?"/.test(readFileSync(path, "utf8"))
    );
    expect(stale).toEqual([]);
  });
});
