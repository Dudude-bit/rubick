import { useState } from "react";
import { ChevronDown, ChevronRight, Cloud, Link } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AzureProfilesSection } from "./cloud/AzureProfilesSection";
import { BindingsTab } from "./cloud/BindingsTab";
import { GcpProfilesSection } from "./cloud/GcpProfilesSection";

export function CloudProfiles() {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <Section>
        <SectionHeader
          title="Cloud Profiles"
          description="Manage GCP and Azure authentication profiles, and bind them to kubeconfig contexts"
          actions={
            <CollapsibleTrigger
              aria-label={isOpen ? "Collapse" : "Expand"}
              className="text-fg-mut hover:text-fg"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </CollapsibleTrigger>
          }
        />
        <CollapsibleContent>
          <Tabs defaultValue="profiles" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="profiles">
                <Cloud className="h-4 w-4 mr-2" />
                Profiles
              </TabsTrigger>
              <TabsTrigger value="bindings">
                <Link className="h-4 w-4 mr-2" />
                Context Bindings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="profiles" className="mt-4">
              <div className="space-y-6">
                <GcpProfilesSection />
                <Separator />
                <AzureProfilesSection />
              </div>
            </TabsContent>
            <TabsContent value="bindings" className="mt-4">
              <BindingsTab />
            </TabsContent>
          </Tabs>
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
}
