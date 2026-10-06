import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScaleDialog } from "./ScaleDialog";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

const scaleButton = () => screen.getByRole("button", { name: /scale/i });

const scale = (over: Partial<Parameters<typeof ScaleDialog>[0]> = {}) => (
  <ScaleDialog
    open
    kind="Deployment"
    name="web"
    namespace="shop"
    current={3}
    busy={false}
    onOpenChange={() => {}}
    onSubmit={() => {}}
    {...over}
  />
);

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: PROD, isConnected: true });
});

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("scaling on critical infrastructure", () => {
  /**
   * Scaling a workload to zero is the change the dialog's red band warns
   * about; without the gate it was still one click, which is exactly what the
   * mark on the cluster exists to stop.
   */
  it("holds the scale button until the cluster's name is typed", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));

    expect(screen.getByRole("alert")).toHaveTextContent(PROD);
    expect(scaleButton()).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(scaleButton()).toBeEnabled();

    await userEvent.click(scaleButton());
    expect(onSubmit).toHaveBeenCalledWith(3);
  });

  /**
   * The Scale button is a plain button, not a Radix close, so the success path
   * closes the dialog by the parent flipping `open` — which never fires
   * onOpenChange. If the gate is reset only there, the typed name survives and
   * the next scale on the same still-mounted surface fires on a stale match.
   */
  it("forgets the typed name once closed, so the next scale re-asks", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const { rerender } = render(scale());

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(scaleButton()).toBeEnabled();

    // The success path: the parent closes the dialog without onOpenChange.
    rerender(scale({ open: false }));
    rerender(scale({ open: true }));

    expect(screen.getByPlaceholderText(PROD)).toHaveValue("");
    expect(scaleButton()).toBeDisabled();
  });

  /**
   * A production-looking name is a guess, never the answer: a guard armed by
   * the name alone would sit on `prod-catalog-dev` until someone found the
   * setting that turns it off.
   */
  it("asks nothing of a cluster nobody marked", () => {
    render(scale());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scaleButton()).toBeEnabled();
  });
});

describe("what the dialog is about", () => {
  /** Restart named its object and Scale said only "Scale Deployment", so the number had no owner on screen. */
  it("names the object whose replicas it sets", () => {
    render(scale());
    expect(screen.getByRole("heading")).toHaveTextContent(
      "Scale Deployment shop/web"
    );
  });
});

describe("submitting from the keyboard", () => {
  /** Lena typed the count and pressed Enter; nothing happened. */
  it("scales on Enter in the replica field", async () => {
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    const field = screen.getByLabelText(/replicas/i);
    await userEvent.clear(field);
    await userEvent.type(field, "5{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(5);
  });

  /** Enter goes through the same gate the button does. */
  it("scales nothing on Enter while the cluster's name is untyped", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    await userEvent.type(screen.getByLabelText(/replicas/i), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("a count read after the dialog opened", () => {
  /**
   * The field is remounted with the count once it lands; it lost the focus
   * then, and the digits typed next went nowhere.
   */
  it("keeps the cursor in the count when the count arrives", () => {
    const { rerender } = render(scale({ current: undefined }));
    expect(screen.getByLabelText(/replicas/i)).toHaveValue(null);
    expect(scaleButton()).toBeDisabled();
    rerender(scale({ current: 4 }));
    const field = screen.getByLabelText(/replicas/i);
    expect(field).toHaveValue(4);
    expect(field).toHaveFocus();
  });

  /** An emptied field scaled to 0 on Enter, read as a count nobody typed. */
  it("scales nothing on Enter in an emptied field, and says why", async () => {
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    const field = screen.getByLabelText(/replicas/i);
    await userEvent.clear(field);
    await userEvent.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Type how many replicas to run, 0 or more.")
    ).toBeInTheDocument();
  });
});
