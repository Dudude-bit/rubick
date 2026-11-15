import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScaleControl } from "./ScaleControl";

type Mutation = Parameters<typeof ScaleControl>[0]["mutation"];

const idle = (mutate = vi.fn()) =>
  ({
    mutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }) as unknown as Mutation;

const control = (over: Partial<Parameters<typeof ScaleControl>[0]> = {}) => (
  <ScaleControl
    kind="Deployment"
    name="web"
    namespace="shop"
    current={3}
    ready
    warnings={[]}
    mutation={idle()}
    {...over}
  />
);

describe("the Scale control", () => {
  /**
   * The open state used to live in the whole detail page, so the press
   * re-rendered every tab before the dialog could draw, one to two seconds on
   * a real Deployment. Fails if the state moves back up to the owner.
   */
  it("opens its dialog without rendering the page that holds it again", async () => {
    let renders = 0;
    const Page = () => {
      renders += 1;
      return control();
    };
    render(<Page />);
    const before = renders;

    await userEvent.click(screen.getByRole("button", { name: /scale/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(renders).toBe(before);
  });

  /** Fails if a press before the object is read opens a dialog with nothing to scale. */
  it("stays shut until the object has been read", async () => {
    render(control({ ready: false }));
    await userEvent.click(screen.getByRole("button", { name: /scale/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /** Fails if a successful write leaves the dialog open over the new count. */
  it("closes when the write succeeds", async () => {
    const mutate = vi.fn((_n: number, options?: { onSuccess?: () => void }) =>
      options?.onSuccess?.()
    );
    render(control({ mutation: idle(mutate as never) }));
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    const field = await screen.findByLabelText(/replicas/i);
    await userEvent.clear(field);
    await userEvent.type(field, "5");
    await userEvent.click(
      screen.getAllByRole("button", { name: /scale/i }).at(-1)!
    );
    expect(mutate).toHaveBeenCalledWith(5, expect.anything());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
