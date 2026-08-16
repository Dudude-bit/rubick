/**
 * A row whose title is a hostname is a row whose title somebody wants on the
 * clipboard — and the title normally sits *inside* the disclosure button,
 * where a second button is neither valid nor operable.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TroubleRow } from "./page-kit";

const row = (copy?: string) =>
  render(
    <MemoryRouter>
      <TroubleRow
        title="shop.example.com"
        copy={copy}
        meta="2 paths"
        state={{ text: "serving", tone: "ok" }}
      >
        <p>the detail</p>
      </TroubleRow>
    </MemoryRouter>
  );

describe("a row whose title can be copied", () => {
  /** The whole point: the name is its own control, not a decoration. */
  it("makes the title a button of its own", () => {
    row("shop.example.com");
    expect(
      screen.getByRole("button", { name: "Copy shop.example.com" })
    ).toBeInTheDocument();
  });

  /** A button inside a button is invalid and does not open. */
  it("does not nest it inside the disclosure", () => {
    row("shop.example.com");
    const copy = screen.getByRole("button", { name: "Copy shop.example.com" });
    expect(copy.closest("button[aria-expanded]")).toBeNull();
  });

  /** The row still opens — from the chevron and from the rest of the line. */
  it("still toggles", () => {
    row("shop.example.com");
    expect(screen.queryByText("the detail")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /shop\.example\.com — expand/ })
    );
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });

  /**
   * Every other page's rows are names of objects, not addresses. Leaving the
   * prop off has to keep the row exactly as it was — one button, one target.
   */
  it("leaves a row with nothing to copy alone", () => {
    row();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });
});

/**
 * The same constraint from the other side. On the pages whose rows *are*
 * objects — an Argo Application, a cert-manager Certificate — the title was
 * plain text with a comment explaining that an anchor cannot be nested in the
 * disclosure button. Which meant the row's own subject was the one thing on
 * the page a reader could not open.
 */
describe("a row whose title is an object", () => {
  const objectRow = (crd?: string) =>
    render(
      <MemoryRouter>
        <TroubleRow
          title="shop"
          reference={{
            kind: "Application",
            name: "shop",
            namespace: "argocd",
            crd,
          }}
          meta="project prod"
          state={{ text: "degraded", tone: "err" }}
        >
          <p>the detail</p>
        </TroubleRow>
      </MemoryRouter>
    );

  it("makes the title a link to the object", () => {
    objectRow("applications.argoproj.io");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/customresourcedefinitions/applications.argoproj.io/instances/argocd/shop"
    );
  });

  it("does not nest it inside the disclosure", () => {
    objectRow("applications.argoproj.io");
    expect(
      screen.getByRole("link").closest("button[aria-expanded]")
    ).toBeNull();
  });

  it("still toggles from the chevron", () => {
    objectRow("applications.argoproj.io");
    expect(screen.queryByText("the detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /shop — expand/ }));
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });

  /**
   * A custom resource with no CRD named cannot be addressed. The row has to
   * fall back to the plain title rather than to a link that renders nothing,
   * which would delete its own subject.
   */
  it("keeps a plain title for an object it cannot address", () => {
    objectRow(undefined);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
