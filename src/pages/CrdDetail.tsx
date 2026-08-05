import { useState } from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, List, Puzzle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { YamlEditor } from "@/components/yaml/YamlEditor";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { SchemaViewer } from "@/components/crds/SchemaViewer";
import { CustomResourceList } from "@/components/resources/CustomResourceList";
import { RealtimeAge } from "@/components/ui/realtime";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";

export function CrdDetail() {
  const { name } = useParams<{ name: string }>();
  const decodedName = name ? decodeURIComponent(name) : undefined;
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("overview");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const goBack = () =>
    navigate(`/${toPlural(ResourceType.CustomResourceDefinition)}`);

  // Fetch CRD details
  const {
    data: crd,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["crd", decodedName],
    queryFn: async () => {
      if (!decodedName) throw new Error("CRD name is required");
      try {
        return await commands.getCrd(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!decodedName,
  });

  // Fetch YAML
  const { data: yaml } = useQuery({
    queryKey: ["crd-yaml", decodedName],
    queryFn: async () => {
      if (!decodedName) throw new Error("CRD name is required");
      try {
        return await commands.getCrdYaml(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!decodedName && activeTab === "yaml",
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!decodedName) return;
      try {
        await commands.deleteCrd(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    onSuccess: () => {
      toast({
        title: "CRD deleted",
        description: `${decodedName} has been deleted.`,
      });
      queryClient.invalidateQueries({ queryKey: ["crds"] });
      navigate(`/${toPlural(ResourceType.CustomResourceDefinition)}`);
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to delete CRD",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const copyYaml = () => {
    if (yaml) {
      navigator.clipboard.writeText(yaml);
      toast({
        title: "Copied",
        description: "YAML copied to clipboard",
      });
    }
  };

  // Get storage version
  const storageVersion = crd?.versions.find((v) => v.storage);
  const currentVersion = selectedVersion
    ? crd?.versions.find((v) => v.name === selectedVersion)
    : storageVersion;

  // Build tabs
  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: crd && (
        <div className="space-y-4">
          {/* Basic Info */}
          <Section>
            <SectionHeader title="Basic Information" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Group</p>
                <p className="font-medium">{crd.group || "core"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Kind</p>
                <p className="font-medium">{crd.kind}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Scope</p>
                <Badge
                  variant={crd.scope === "Namespaced" ? "default" : "secondary"}
                >
                  {crd.scope}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Age</p>
                <p className="font-medium">
                  <RealtimeAge timestamp={crd.createdAt} fallback="-" />
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Plural</p>
                <p className="font-medium">{crd.plural}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Singular</p>
                <p className="font-medium">{crd.singular || "-"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Short Names</p>
                <div className="flex gap-1 flex-wrap">
                  {crd.shortNames.length > 0 ? (
                    crd.shortNames.map((sn) => (
                      <Badge key={sn} variant="outline">
                        {sn}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Categories</p>
                <div className="flex gap-1 flex-wrap">
                  {crd.categories.length > 0 ? (
                    crd.categories.map((cat) => (
                      <Badge key={cat} variant="outline">
                        {cat}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
              </div>
            </div>
          </Section>

          {/* Versions */}
          <Section>
            <SectionHeader title="Versions" />
            <div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-3">Version</th>
                      <th className="text-left py-2 px-3">Served</th>
                      <th className="text-left py-2 px-3">Storage</th>
                      <th className="text-left py-2 px-3">Deprecated</th>
                      <th className="text-left py-2 px-3">Columns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crd.versions.map((version) => (
                      <tr key={version.name} className="border-b last:border-0">
                        <td className="py-2 px-3 font-medium">
                          {version.name}
                        </td>
                        <td className="py-2 px-3">
                          <Badge
                            variant={version.served ? "default" : "secondary"}
                          >
                            {version.served ? "Yes" : "No"}
                          </Badge>
                        </td>
                        <td className="py-2 px-3">
                          <Badge
                            variant={version.storage ? "default" : "secondary"}
                          >
                            {version.storage ? "Yes" : "No"}
                          </Badge>
                        </td>
                        <td className="py-2 px-3">
                          {version.deprecated ? (
                            <Badge variant="destructive">Deprecated</Badge>
                          ) : (
                            <span className="text-muted-foreground">No</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {version.additionalPrinterColumns.length > 0 ? (
                            <span>
                              {version.additionalPrinterColumns.length} columns
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              Default
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Section>

          {/* Conditions */}
          {crd.conditions.length > 0 && (
            <ConditionsDisplay
              conditions={crd.conditions.map((c) => ({
                type: c.conditionType,
                status: c.status,
                reason: c.reason,
                message: c.message,
                lastTransitionTime: c.lastTransitionTime,
              }))}
            />
          )}

          {/* Labels & Annotations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.keys(crd.labels).length > 0 && (
              <LabelsDisplay labels={crd.labels} title="Labels" />
            )}
            {Object.keys(crd.annotations).length > 0 && (
              <LabelsDisplay labels={crd.annotations} title="Annotations" />
            )}
          </div>
        </div>
      ),
    },
    {
      id: "schema",
      label: "Schema",
      content: (
        <Section>
          <SectionHeader
            title="OpenAPI Schema"
            actions={
              crd &&
              crd.versions.length > 1 && (
                <div className="flex gap-2">
                  {crd.versions.map((v) => (
                    <Button
                      key={v.name}
                      variant={
                        (selectedVersion || storageVersion?.name) === v.name
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      onClick={() => setSelectedVersion(v.name)}
                    >
                      {v.name}
                      {v.storage && " (storage)"}
                    </Button>
                  ))}
                </div>
              )
            }
          />
          <div>
            {currentVersion?.schema ? (
              <SchemaViewer schema={currentVersion.schema} />
            ) : (
              <p className="text-muted-foreground">
                No schema available for this version.
              </p>
            )}
          </div>
        </Section>
      ),
    },
    {
      id: "instances",
      label: "Instances",
      content: crd && (
        <CustomResourceList
          crdName={crd.name}
          crdKind={crd.kind}
          crdGroup={crd.group}
          crdVersion={storageVersion?.name ?? crd.versions[0]?.name ?? "v1"}
          crdPlural={crd.plural}
          scope={crd.scope as "Namespaced" | "Cluster"}
          printerColumns={storageVersion?.additionalPrinterColumns}
          embedded
        />
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <Section>
          <SectionHeader
            title="YAML Definition"
            actions={
              <Button variant="outline" size="sm" onClick={copyYaml}>
                Copy
              </Button>
            }
          />
          <div>
            {yaml ? (
              <YamlEditor value={yaml} readOnly height="500px" />
            ) : (
              <div className="h-32 flex items-center justify-center text-muted-foreground">
                Loading YAML...
              </div>
            )}
          </div>
        </Section>
      ),
    },
  ];

  return (
    <>
      <ResourceDetailLayout
        resource={crd}
        isLoading={isLoading}
        error={error}
        resourceKind="CustomResourceDefinition"
        title={crd?.kind || ""}
        namespace={undefined}
        statusBadge={
          crd && (
            <Badge
              variant={crd.scope === "Namespaced" ? "default" : "secondary"}
            >
              {crd.scope}
            </Badge>
          )
        }
        badges={
          crd && (
            <span className="text-muted-foreground text-sm">{crd.name}</span>
          )
        }
        icon={<Puzzle className="h-8 w-8 text-muted-foreground" />}
        onBack={goBack}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link
                to={`/${toPlural(ResourceType.CustomResourceDefinition)}/${encodeURIComponent(decodedName || "")}/instances`}
              >
                <List className="h-4 w-4 mr-2" />
                View Instances
              </Link>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </>
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete CRD?"
        description={`Are you sure you want to delete "${decodedName}"? This will also delete all instances of this custom resource.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmDisabled={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
          setDeleteDialogOpen(false);
        }}
      />
    </>
  );
}
