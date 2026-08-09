import { Router } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";
import { facts } from "./facts";

/**
 * Traefik.
 *
 * Tier two. Nothing here is configured — the CRDs are in the API server or
 * they are not — and nothing is fetched until the reader opens the one
 * screen that names it.
 */
export default defineVendor({
  id: "traefik",
  name: "Traefik",
  extension: {
    gives: "IngressRoutes read as routing rather than as raw custom resources",
    icon: Router,
    facts,
  },
  crd,
});
