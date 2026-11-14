import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { refusedFor } from "@/lib/changes";
import { ShowFilter } from "./ShowFilter";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("a filter the cluster refused a kind of", () => {
  /**
   * A kind whose watch was refused is named as not followed in the filter,
   * not only on the page. Fails if Warnings only stays silent with Event
   * refused, or Changes only blames Event for what it never showed.
   */
  it("names the refused kind on the filter that cannot answer for it", () => {
    const events = { unwatched: ["Event"] };
    expect(refusedFor("warnings", events, t)).toBe(
      "Event: refused by the cluster, not followed"
    );
    expect(refusedFor("changes", events, t)).toBeNull();
    expect(refusedFor("all", events, t)).toBeNull();
    expect(refusedFor("changes", { unwatchedIn: ["Secret/shop"] }, t)).toBe(
      "Secret: refused by the cluster, not followed"
    );
  });

  /** Fails if the lock the filter carries is not there to be read. */
  it("draws the refusal on the button itself", () => {
    render(
      <ShowFilter
        show="all"
        onShow={vi.fn()}
        watching={{ unwatched: ["Event"] }}
      />
    );
    const warnings = screen.getByRole("button", { name: /Warnings only/ });
    expect(warnings).toHaveAttribute(
      "title",
      "Event: refused by the cluster, not followed"
    );
    expect(
      screen.getByRole("button", { name: /Changes only/ })
    ).not.toHaveAttribute("title");
  });
});
