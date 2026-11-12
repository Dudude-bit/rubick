import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { SchemaViewer } from "./SchemaViewer";

const string = { type: "string" };

describe("the schema a CRD's page draws", () => {
  /**
   * Argo CD's Application keeps `operation` at the root beside `spec`, and
   * a CiliumNetworkPolicy its `specs`. Fails if a root property is left out
   * once spec or status exists: the tab then shows part of the schema as
   * the whole of it.
   */
  it("draws the root properties that stand beside spec and status", () => {
    render(
      <SchemaViewer
        schema={{
          type: "object",
          required: ["spec"],
          properties: {
            spec: { type: "object", properties: { project: string } },
            status: { type: "object", properties: { health: string } },
            operation: { type: "object", properties: { retry: string } },
          },
        }}
      />
    );
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("health")).toBeInTheDocument();
    expect(screen.getByText("operation")).toBeInTheDocument();
    expect(screen.getByText("retry")).toBeInTheDocument();
  });

  /** A kind with neither keeps every root property, as before. */
  it("draws every root property of a kind with no spec and no status", () => {
    render(
      <SchemaViewer
        schema={{
          type: "object",
          properties: { summary: string, scope: string },
        }}
      />
    );
    expect(screen.getByText("summary")).toBeInTheDocument();
    expect(screen.getByText("scope")).toBeInTheDocument();
  });

  /**
   * A map has no properties, only what its values are, and an open object
   * only the mark that it is open. Fails if either cannot be opened: the
   * note was drawn only inside a block that never showed.
   */
  it("says what a map holds and that an open object is open", () => {
    render(
      <SchemaViewer
        schema={{
          type: "object",
          properties: {
            spec: {
              type: "object",
              properties: {
                selector: { type: "object", additionalProperties: string },
                values: {
                  type: "object",
                  "x-kubernetes-preserve-unknown-fields": true,
                },
              },
            },
          },
        }}
      />
    );
    expect(screen.getByText("[additionalProperties]")).toBeInTheDocument();
    expect(screen.getByText("(preserves unknown fields)")).toBeInTheDocument();
  });
});
