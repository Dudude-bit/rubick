import { CliSettings } from "./CliSettings";
import { CloudProfiles } from "./CloudProfiles";
import { KubeconfigSettings } from "./KubeconfigSettings";

/**
 * The three groups that are one story, in the order the reader meets them.
 *
 * Kubeconfig first: nothing has a name until that file is read, so every
 * other decision here is downstream of it. Cloud profiles second: a
 * context that exists but will not connect is an identity problem, and
 * this is where the identity is chosen. CLI tools last, because helm and
 * an exec-based kubectl only matter once the first two have produced a
 * cluster to point them at.
 *
 * That is also the order things fail in, which is the order somebody
 * arriving with a broken connection reads them.
 */
export function ClustersSettings() {
  return (
    <div className="flex flex-col gap-5">
      <KubeconfigSettings />
      <CloudProfiles />
      <CliSettings />
    </div>
  );
}
