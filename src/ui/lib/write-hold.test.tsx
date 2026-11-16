import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { toast, useToast } from "@/components/ui/use-toast";
import { holdWriteToasts } from "./write-hold";

describe("a dialog holding the toasts of the write it shows", () => {
  /** Fails if a refusal shown inside the dialog is also raised as a toast, which said it twice. */
  it("drops a failure toast while the write is out and lets the next one through", () => {
    const { result } = renderHook(() => useToast());
    const release = holdWriteToasts();
    act(() => {
      toast({ title: "Could not scale", variant: "destructive" });
    });
    expect(result.current.toasts).toHaveLength(0);
    release();
    act(() => {
      toast({ title: "Could not scale", variant: "destructive" });
    });
    expect(result.current.toasts).toHaveLength(1);
  });

  /** Fails if a release called twice lets a later hold leak, silencing toasts for good. */
  it("counts a release once", () => {
    const { result } = renderHook(() => useToast());
    const release = holdWriteToasts();
    release();
    release();
    act(() => {
      toast({ title: "Could not delete", variant: "destructive" });
    });
    expect(result.current.toasts.length).toBeGreaterThan(0);
  });
});
