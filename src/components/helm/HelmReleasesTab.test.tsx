/**
 * A Helm-release list read that the cluster refused must read as a refusal —
 * not as an empty "no releases" table, which is the empty-collection-on-a-403
 * collapse the app exists to prevent. A refusal that still returned some rows
 * (another namespace answered) shows those rows. Deleting the error branch or
 * the isRefusal split puts the silent-empty-table back.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { HelmRelease } from "@/generated/types";
import { HelmReleasesTab } from "./HelmReleasesTab";

const release = (name: string): HelmRelease => ({
  name,
  namespace: "team-a",
  revision: 1,
  status: "deployed",
  chart: "nginx-1.0.0",
  appVersion: "1.0.0",
  updated: "2026-09-05T10:00:00Z",
  source: "native",
  suspended: false,
  sourceRef: null,
});

function mount(props: Partial<Parameters<typeof HelmReleasesTab>[0]> = {}) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <HelmReleasesTab
          releases={[]}
          isLoading={false}
          error={null}
          helmCliAvailable={true}
          onRefetch={vi.fn()}
          onShowHistory={vi.fn()}
          onUpgrade={vi.fn()}
          onRollback={vi.fn()}
          onUninstall={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe("what the releases tab does when the read fails", () => {
  // The errors are raw strings on purpose: the query's thrown value is not
  // guaranteed to be an Error, and reading `.message` off a string (the old
  // code did) throws mid-render. Passing an Error here would test a shape the
  // page need not produce and hide that crash — so these are strings, the
  // harsher case.
  it("names a refusal instead of showing an empty table", () => {
    mount({
      error:
        "Tauri command 'listHelmReleasesNative' failed: secrets is forbidden (code: 403)",
    });

    expect(
      screen.getByText(/do not have permission to list/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/secrets is forbidden/)).toBeInTheDocument();
    // The framing prefix is off the message.
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
  });

  it("calls a non-refusal failure a read error, not a refusal", () => {
    mount({ error: "error trying to connect: connection refused" });

    expect(
      screen.getByText(/Could not read Helm releases/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to list/i)
    ).not.toBeInTheDocument();
  });

  it("still shows the rows a readable namespace returned despite a sibling's refusal", () => {
    mount({
      releases: [release("api"), release("web")],
      error: "secrets is forbidden (code: 403)",
    });

    // Rows present -> the table, not the refusal block.
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to list/i)
    ).not.toBeInTheDocument();
  });
});
