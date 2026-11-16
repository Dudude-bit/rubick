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

  /**
   * The autoscaler paragraph arrived half a second after the field and pushed
   * it down 190px under the pointer. Fails if the field is drawn before the
   * autoscaler read answered, or never drawn once it has.
   */
  it("holds the field back until the autoscaler read has answered", async () => {
    const { rerender } = render(control({ reading: true }));
    await userEvent.click(screen.getByRole("button", { name: /scale/i }));
    expect(await screen.findByTestId("scale-pending")).toBeInTheDocument();
    expect(screen.queryByLabelText(/replicas/i)).toBeNull();

    rerender(
      control({
        reading: false,
        warnings: [
          {
            key: "hpa:web",
            subject: "Autoscaler web",
            lead: "The autoscaler web owns this replica count.",
            description: "It will put this number back.",
            to: null,
          },
        ],
      })
    );
    expect(await screen.findByLabelText(/replicas/i)).toBeInTheDocument();
    expect(screen.queryByTestId("scale-pending")).toBeNull();
    expect(
      screen.getByText(/The autoscaler web owns this replica count/)
    ).toBeInTheDocument();
  });

  /**
   * A read that never answers must not lock the dialog on its placeholder.
   * Fails if the field never appears, or appears without saying the read is
   * still out.
   */
  it("shows the field and says the read is out when it does not answer", async () => {
    render(control({ reading: true }));
    await userEvent.click(screen.getByRole("button", { name: /scale/i }));
    expect(
      await screen.findByLabelText(/replicas/i, undefined, { timeout: 4000 })
    ).toBeInTheDocument();
    expect(screen.getByTestId("scale-still-reading")).toBeInTheDocument();
  }, 8000);

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
