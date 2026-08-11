import { defineVendor } from "../registry";

/**
 * k3s, and k3d — k3s in Docker, which is what this project's own dev
 * cluster is.
 *
 * Two flavours and no mark: both wear the Kubernetes heptagon, because
 * neither has a mark of its own that a reader would recognise at 13px, and
 * inventing one would say something the app does not know.
 *
 * They are first in the registry so that `k3d-prod-eks-replica` reads as
 * the local cluster it is rather than as the cloud it imitates.
 */
export default defineVendor({
  id: "k3s",
  name: "k3s",
  flavours: [
    { id: "k3d", claims: (name) => name.startsWith("k3d-"), label: "K3D" },
    { id: "k3s", claims: (_, hasWord) => hasWord("k3s"), label: "K3S" },
  ],
});
