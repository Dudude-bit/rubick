import { Crosshair } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import { MONITORS_KEY, MONITORS_STALE, fetchServiceMonitors } from "./data";

export default defineVendor({
  id: "prometheus-operator",
  name: "Prometheus Operator",
  extension: {
    gives: "prometheusOperatorGives",
    icon: Crosshair,
  },
  page: {
    count: pageCount({
      queryKey: MONITORS_KEY,
      queryFn: fetchServiceMonitors,
      select: (monitors) => monitors.length,
      staleTime: MONITORS_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
