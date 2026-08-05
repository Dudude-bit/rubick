// src/components/resources/ImagePullSecrets.tsx
import { Section, SectionHeader } from "@/components/ui/section";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

interface ImagePullSecretsProps {
  secrets: string[];
  namespace?: string;
}

export function ImagePullSecrets({
  secrets,
  namespace,
}: ImagePullSecretsProps) {
  const [isExpanded, setIsExpanded] = useState(secrets.length > 0);

  return (
    <Collapsible asChild open={isExpanded} onOpenChange={setIsExpanded}>
      <Section>
        <SectionHeader
          title="Image Pull Secrets"
          count={secrets.length}
          actions={
            <CollapsibleTrigger
              aria-label={isExpanded ? "Collapse" : "Expand"}
              className="text-fg-mut hover:text-fg"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </CollapsibleTrigger>
          }
        />
        <CollapsibleContent>
          {secrets.length === 0 ? (
            <p className="text-sm text-fg-mut">
              No image pull secrets configured
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {secrets.map((secretName) => (
                <Link
                  key={secretName}
                  to={
                    namespace
                      ? `/configuration/secrets/${namespace}/${secretName}`
                      : "#"
                  }
                  className="flex items-center gap-2 text-sm border border-hair rounded px-3 py-1.5 hover:bg-hover transition-colors"
                >
                  <Lock className="h-3 w-3 text-warn" />
                  <span className="font-mono text-xs">{secretName}</span>
                </Link>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
}
