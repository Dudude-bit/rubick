import { Database } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import { CLUSTERS_KEY, CNPG_STALE, fetchClusters } from "./data";
import { facts } from "./facts";
import { readCluster } from "./model";

export default defineVendor({
  id: "cloudnativepg",
  name: "CloudNativePG",
  extension: {
    gives: "cloudnativepgGives",
    icon: Database,
    facts,
    operator: true,
  },
  page: {
    count: pageCount({
      queryKey: CLUSTERS_KEY,
      queryFn: fetchClusters,
      select: (clusters) => clusters.length,
      tone: (clusters) => {
        const read = clusters.map(readCluster);
        if (read.some((c) => c.worst === "err")) return "err";
        if (read.some((c) => c.worst === "warn")) return "warn";
        return null;
      },
      staleTime: CNPG_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
