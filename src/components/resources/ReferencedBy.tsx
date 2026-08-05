// src/components/resources/ReferencedBy.tsx
import { useQuery } from "@tanstack/react-query";
import { Section, SectionHeader } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronDown,
  ChevronRight,
  Lock,
  FileKey,
  HardDrive,
  Globe,
  Image,
} from "lucide-react";
import { useState } from "react";
import { ResourceLink } from "@/components/shared";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { ResourceReferences } from "@/generated/types";

interface ReferencedByProps {
  resourceType: "Secret" | "ConfigMap";
  name: string;
  namespace: string;
}

interface RefGroupProps {
  title: string;
  icon: React.ElementType;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function RefGroup({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  children,
}: RefGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen || count > 0);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 hover:bg-hover rounded transition-colors">
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <Icon className="h-4 w-4 text-fg-mut" />
        <span className="font-medium text-sm">{title}</span>
        <Badge
          variant={count > 0 ? "default" : "secondary"}
          className="ml-auto"
        >
          {count}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-8 pr-2 pb-2 space-y-2">
        {count === 0 ? (
          <p className="text-sm text-fg-mut py-2">No references found</p>
        ) : (
          children
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ReferencedBy({
  resourceType,
  name,
  namespace,
}: ReferencedByProps) {
  const { data, isLoading, error } = useQuery<ResourceReferences>({
    queryKey: ["resourceReferences", resourceType, name, namespace],
    queryFn: () =>
      commands.getResourceReferences(resourceType, name, namespace),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="h-6 w-6" />
        <span className="ml-2 text-fg-mut">Loading references...</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-err text-sm py-4">
        Failed to load references: {String(error)}
      </p>
    );
  }

  const refs = data || {
    envVars: [],
    envFrom: [],
    volumes: [],
    imagePullSecrets: [],
    tlsIngress: [],
  };
  const totalCount =
    refs.envVars.length +
    refs.envFrom.length +
    refs.volumes.length +
    refs.imagePullSecrets.length +
    refs.tlsIngress.length;

  return (
    <Section>
      <SectionHeader title="Referenced By" count={totalCount} />
      <div className="flex flex-col gap-1">
        <RefGroup
          title="Environment Variables"
          icon={resourceType === ResourceType.Secret ? Lock : FileKey}
          count={refs.envVars.length}
          defaultOpen={refs.envVars.length > 0}
        >
          {refs.envVars.map((ref, i) => (
            <ResourceLink
              key={`env-${i}`}
              kind={ref.kind}
              name={ref.name}
              namespace={ref.namespace}
              subtitle={
                ref.containerName
                  ? `Container: ${ref.containerName}${ref.key ? ` → ${ref.key}` : ""}`
                  : undefined
              }
            />
          ))}
        </RefGroup>

        <RefGroup
          title="EnvFrom (Bulk Import)"
          icon={resourceType === ResourceType.Secret ? Lock : FileKey}
          count={refs.envFrom.length}
          defaultOpen={refs.envFrom.length > 0}
        >
          {refs.envFrom.map((ref, i) => (
            <ResourceLink
              key={`envfrom-${i}`}
              kind={ref.kind}
              name={ref.name}
              namespace={ref.namespace}
              subtitle={
                ref.containerName
                  ? `Container: ${ref.containerName} (all keys)`
                  : undefined
              }
            />
          ))}
        </RefGroup>

        <RefGroup
          title="Volume Mounts"
          icon={HardDrive}
          count={refs.volumes.length}
          defaultOpen={refs.volumes.length > 0}
        >
          {refs.volumes.map((ref, i) => (
            <ResourceLink
              key={`vol-${i}`}
              kind={ref.kind}
              name={ref.name}
              namespace={ref.namespace}
              subtitle={`${ref.containerName ? `${ref.containerName} → ` : ""}${ref.mountPath}`}
            />
          ))}
        </RefGroup>

        {resourceType === ResourceType.Secret && (
          <>
            <RefGroup
              title="Image Pull Secrets"
              icon={Image}
              count={refs.imagePullSecrets.length}
            >
              {refs.imagePullSecrets.map((ref, i) => (
                <ResourceLink
                  key={`pull-${i}`}
                  kind={ref.kind}
                  name={ref.name}
                  namespace={ref.namespace}
                />
              ))}
            </RefGroup>

            <RefGroup
              title="TLS Ingress"
              icon={Globe}
              count={refs.tlsIngress.length}
            >
              {refs.tlsIngress.map((ref, i) => (
                <ResourceLink
                  key={`tls-${i}`}
                  kind="Ingress"
                  name={ref.name}
                  namespace={ref.namespace}
                  subtitle={
                    ref.hosts.length > 0
                      ? `Hosts: ${ref.hosts.join(", ")}`
                      : undefined
                  }
                />
              ))}
            </RefGroup>
          </>
        )}
      </div>
    </Section>
  );
}
