import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Unknown } from "./unknown";

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const REFUSED =
  'Tauri command \'getConnections\' failed: endpointslices.discovery.k8s.io is forbidden: User "kirya" cannot list resource "endpointslices" in API group "discovery.k8s.io" in the namespace "shop"';

describe("Unknown", () => {
  beforeEach(() => writeText.mockClear());

  /** A refusal with no way out leaves the reader exactly where the sentence left them. */
  it("turns a refusal into the rule to ask for", async () => {
    render(
      <Unknown
        question="Who is behind this Service?"
        error={new Error(REFUSED)}
      />
    );
    expect(screen.getByText("Who is behind this Service?")).toBeInTheDocument();
    expect(screen.getByText(/cluster refused/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /rule/i }));
    const yaml = writeText.mock.calls[0][0] as string;
    expect(yaml).toContain("kind: Role");
    expect(yaml).toContain("namespace: shop");
    expect(yaml).toContain('resources: ["endpointslices"]');
  });

  /** A network fault names no subject; offering a rule for it would be a lie. */
  it("offers a retry for a fault and no rule", async () => {
    const retry = vi.fn();
    render(
      <Unknown
        question="Usage history"
        error={new Error("connection refused")}
        onRetry={retry}
      />
    );
    expect(
      screen.queryByRole("button", { name: /rule/i })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  /** Our own command wrapper's prefix is framing, not what the server said. */
  it("shows the server's words without the command framing", () => {
    render(<Unknown question="q" error={new Error(REFUSED)} />);
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/endpointslices\.discovery\.k8s\.io is forbidden/)
    ).toBeInTheDocument();
  });
});
