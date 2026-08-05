import { Cloud, Link } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AzureProfilesSection } from "./cloud/AzureProfilesSection";
import { BindingsTab } from "./cloud/BindingsTab";
import { GcpProfilesSection } from "./cloud/GcpProfilesSection";
import { SettingsGroup } from "./settings-row";

export function CloudProfiles() {
  return (
    <Tabs defaultValue="profiles">
      <SettingsGroup title="Cloud profiles">
        {/* The caption line carries the tabs. A collapsible header with a
            chevron used to sit above them, which made one group of a flat
            settings page behave unlike every other group on it. */}
        <div className="flex items-center justify-between gap-4 py-1.5">
          <p className="text-[11px] text-fg-mut">
            GCP and Azure authentication, and which kubeconfig context uses
            which profile.
          </p>
          <TabsList>
            <TabsTrigger value="profiles">
              <Cloud className="h-3 w-3" aria-hidden="true" />
              Profiles
            </TabsTrigger>
            <TabsTrigger value="bindings">
              <Link className="h-3 w-3" aria-hidden="true" />
              Bindings
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="profiles" className="mt-0">
          <GcpProfilesSection />
          <AzureProfilesSection />
        </TabsContent>
        <TabsContent value="bindings" className="mt-0">
          <BindingsTab />
        </TabsContent>
      </SettingsGroup>
    </Tabs>
  );
}
