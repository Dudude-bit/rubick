import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SectionHeader } from "@/components/ui/section";
import { ResourceDetailLayout } from "./ResourceDetailLayout";

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const base = {
  // A loaded object: the layout renders its "not found" state instead when
  // `resource` is nullish, and that state has no tabs at all.
  resource: { name: "pv-demo" },
  title: "pv-demo",
  resourceKind: "PersistentVolume",
  isLoading: false,
  error: null,
  onBack: () => {},
  onTabChange: () => {},
};

/**
 * A surface tab reclaims the page's height by hiding the blocks the page
 * renders above the tab strip. That is a fair trade only while some other tab
 * still shows them — on a page whose every tab is a surface it is not a trade
 * at all, and PersistentVolume lost its capacity, binding and reclaim policy
 * outright until this was caught.
 */
describe("ResourceDetailLayout with only surface tabs", () => {
  it("keeps the page's own blocks visible when no tab would ever show them", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="yaml"
        tabs={[{ id: "yaml", label: "YAML", kind: "surface", content: null }]}
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    expect(screen.getByText("capacity 2Gi").parentElement).not.toHaveClass(
      "hidden"
    );
  });

  it("still hides them on a surface tab when another tab shows them", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="logs"
        tabs={[
          { id: "overview", label: "Overview", content: null },
          { id: "logs", label: "Logs", kind: "surface", content: null },
        ]}
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    // Asserted on the wrapper's class rather than on visibility: `hidden` is a
    // Tailwind utility and jsdom loads no stylesheet, so `toBeVisible` cannot
    // see it. Kept mounted either way — dialogs a page hangs here portal to
    // the body and have to survive the tab that opened them.
    expect(screen.getByText("capacity 2Gi").parentElement).toHaveClass(
      "hidden"
    );
  });

  it("shows them again on the sections tab", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[
          { id: "overview", label: "Overview", content: null },
          { id: "logs", label: "Logs", kind: "surface", content: null },
        ]}
      >
        <p>capacity 2Gi</p>
      </ResourceDetailLayout>
    );
    expect(screen.getByText("capacity 2Gi").parentElement).not.toHaveClass(
      "hidden"
    );
  });
});

/**
 * The strip is a heading. Whatever a tab opens with does not get to say the
 * word the reader just clicked, and no block gets to say the kind the
 * breadcrumb and the title already carry.
 */
describe("ResourceDetailLayout captions", () => {
  it("drops a block heading that only repeats the tab label", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="conditions"
        tabs={[
          {
            id: "conditions",
            label: "Conditions",
            content: <SectionHeader title="Conditions" />,
          },
        ]}
      />
    );
    expect(
      screen.queryByRole("heading", { name: "Conditions" })
    ).not.toBeInTheDocument();
  });

  it("keeps the count the strip does not carry, with its noun", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="conditions"
        tabs={[
          {
            id: "conditions",
            label: "Conditions",
            content: <SectionHeader title="Conditions" count={3} />,
          },
        ]}
      />
    );
    expect(screen.getByText("3 conditions")).toBeInTheDocument();
  });

  it("drops a block heading that only repeats the kind", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="overview"
        tabs={[{ id: "overview", label: "Overview", content: null }]}
      >
        <SectionHeader title="PersistentVolume" />
      </ResourceDetailLayout>
    );
    expect(
      screen.queryByRole("heading", { name: "PersistentVolume" })
    ).not.toBeInTheDocument();
  });

  it("leaves a heading that says something new", () => {
    wrap(
      <ResourceDetailLayout
        {...base}
        activeTab="access"
        tabs={[
          {
            id: "access",
            label: "Access",
            content: <SectionHeader title="Reachable at" />,
          },
        ]}
      />
    );
    expect(
      screen.getByRole("heading", { name: "Reachable at" })
    ).toBeInTheDocument();
  });
});
