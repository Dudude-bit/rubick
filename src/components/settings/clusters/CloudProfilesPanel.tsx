import { AzureProfilesSection } from "../cloud/AzureProfilesSection";
import { GcpProfilesSection } from "../cloud/GcpProfilesSection";

/**
 * The profile manager, which is not the thing anyone comes here to read.
 *
 * Adding a service-account key is rare; knowing which profile a context is
 * using is constant. So the binding is printed on the context row and the
 * editor — add, edit, test, delete, for both clouds — is one link away.
 *
 * It opens in place rather than in a dialog because both profile sections
 * own a dialog of their own for the edit itself, and a dialog inside a
 * dialog is a dialog that does not open.
 */
export function CloudProfilesPanel() {
  return (
    <div className="mt-3 border-t border-hair pt-2">
      <p className="pb-1 text-[11px] text-fg-mut">
        Named credentials for GKE and AKS. A context with none of them
        authenticates the way its plugin does by default.
      </p>
      <GcpProfilesSection />
      <AzureProfilesSection />
    </div>
  );
}
