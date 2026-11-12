import { describe, expect, it } from "vite-plus/test";

import { appSearch } from "./app-search";

describe("the query a screen reads", () => {
  /** The router parses `?q=123` as a number; a search box would then read nothing. */
  it("keeps every value a string", () => {
    expect(appSearch({ q: 123, tab: "logs" })).toEqual({
      q: "123",
      tab: "logs",
    });
  });

  /** A key no screen reads must not ride along into a tab record or a deep link. */
  it("drops keys no screen reads", () => {
    expect(appSearch({ shell: "app", action: "restart" })).toEqual({
      shell: "app",
    });
  });
});
