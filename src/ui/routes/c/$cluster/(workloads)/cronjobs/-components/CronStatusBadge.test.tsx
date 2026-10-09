import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import { CronStatusBadge } from "./CronStatusBadge";

afterEach(() => useLocaleStore.setState({ choice: "en" }));

describe("a CronJob's status badge in Russian", () => {
  /** Lena read an English "Suspended" badge beside a Russian CronJobs row; both words are the app's. */
  it("words Suspended and Active, which the app composes from spec.suspend", () => {
    useLocaleStore.setState({ choice: "ru" });
    const { rerender } = render(<CronStatusBadge suspend />);
    expect(screen.getByText("Приостановлен")).toBeInTheDocument();
    rerender(<CronStatusBadge suspend={false} />);
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });
});
