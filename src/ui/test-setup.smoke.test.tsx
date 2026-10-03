import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

// Smoke test for the UI test infra itself. If this fails, every UI test
// downstream will too — so the failure should be obvious here, not in some
// component test.

function Counter() {
  const [n, setN] = useState(0);
  return (
    <div>
      <span data-testid="value">{n}</span>
      <button onClick={() => setN(n + 1)}>Increment</button>
    </div>
  );
}

describe("test infrastructure smoke", () => {
  it("renders a React component into jsdom", () => {
    render(<Counter />);
    expect(screen.getByTestId("value")).toHaveTextContent("0");
  });

  it("user-event clicks trigger React state updates", async () => {
    const user = userEvent.setup();
    render(<Counter />);
    await user.click(screen.getByRole("button", { name: /increment/i }));
    expect(screen.getByTestId("value")).toHaveTextContent("1");
  });

  it("jest-dom matchers are wired up", () => {
    render(<Counter />);
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
