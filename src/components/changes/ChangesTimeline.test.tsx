import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChangeItem } from "@/lib/changes";
import { ChangesTimeline } from "./ChangesTimeline";

const T0 = Date.parse("2026-09-08T02:10:00Z");
const HOUR = 60 * 60_000;

function mount(items: ChangeItem[], since?: number) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ChangesTimeline items={items} since={since} showObject />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe("ChangesTimeline", () => {
  /** A gap is drawn as its own row, in words, not as an empty stretch a reader would read as calm. */
  it("draws a gap as a gap", () => {
    mount([
      {
        kind: "journal",
        at: T0 + 6 * HOUR,
        entry: {
          id: "j",
          context: "dev",
          kind: "Deployment",
          namespace: "shop",
          name: "api",
          at: T0 + 6 * HOUR,
          field: "image",
          key: "0",
          from: "app:1",
          to: "app:2",
        },
      },
      {
        kind: "gap",
        at: T0 + 5.5 * HOUR,
        gap: { from: T0, to: T0 + 5.5 * HOUR },
      },
    ]);
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/^Not observed /);
    expect(document.body.textContent).toContain("image app:1 → app:2");
  });

  it("marks what happened after the moment the reader came from", () => {
    mount(
      [
        {
          kind: "journal",
          at: T0 + 2 * HOUR,
          entry: {
            id: "new",
            context: "dev",
            kind: "Deployment",
            namespace: "shop",
            name: "api",
            at: T0 + 2 * HOUR,
            field: "replicas",
            key: null,
            from: "2",
            to: "3",
          },
        },
        {
          kind: "journal",
          at: T0,
          entry: {
            id: "old",
            context: "dev",
            kind: "Deployment",
            namespace: "shop",
            name: "api",
            at: T0,
            field: "replicas",
            key: null,
            from: "1",
            to: "2",
          },
        },
      ],
      T0 + HOUR
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-after-since", "true");
    expect(rows[1]).not.toHaveAttribute("data-after-since");
  });

  it("says the oldest revision has nothing to compare with", () => {
    mount([
      {
        kind: "revision",
        at: T0,
        against: { state: "oldest" },
        readopted: false,
        revision: {
          id: "r1",
          number: 1,
          name: "api-1",
          current: true,
          at: new Date(T0).toISOString(),
          changeCause: "first deploy",
          containers: [],
          initContainers: [],
          templateAnnotations: {},
          templateKnown: true,
        },
      },
    ]);
    expect(document.body.textContent).toContain("revision 1");
    expect(document.body.textContent).toContain("first deploy");
    expect(document.body.textContent).toContain("oldest known");
  });
});
