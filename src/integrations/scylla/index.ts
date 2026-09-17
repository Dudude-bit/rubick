import { Layers } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import {
  CLUSTERS_CRD,
  CLUSTERS_KEY,
  SCYLLA_STALE,
  fetchClusters,
} from "./data";
import { facts } from "./facts";
import { readScyllaCluster } from "./model";

export default defineVendor({
  id: "scylla",
  name: "Scylla",
  extension: {
    gives: "scyllaGives",
    icon: Layers,
    facts,
    operator: true,
  },
  page: {
    count: pageCount({
      queryKey: CLUSTERS_KEY,
      queryFn: fetchClusters,
      select: (clusters) => clusters.length,
      tone: (clusters) => {
        const read = clusters.map((c) => readScyllaCluster(c));
        if (read.some((c) => c.worst === "err")) return "err";
        if (read.some((c) => c.worst === "warn")) return "warn";
        return null;
      },
      staleTime: SCYLLA_STALE,
    }),
    load: () => import("./page"),
    gate: { crd: CLUSTERS_CRD, namespaced: true },
  },
  crd,
});
