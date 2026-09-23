import { commands } from "@/lib/commands";
import { ClaimRef } from "./storage-refs";
import { list, ref, source, type PeekSources } from "./peek-sources-kit";

export const CONFIG_STORAGE_SOURCES: PeekSources = {
  ConfigMap: source(commands.getConfigmap, (configMap, _target, t) => ({
    createdAt: configMap.createdAt,
    groups: [
      {
        title: t("columns", "data"),
        count: configMap.dataKeys.length,
        items: configMap.dataKeys.map((key) => ({
          label: key,
          value: "",
          mono: true,
        })),
        emptyMessage: t("empty", "noKeys"),
      },
    ],
  })),

  Secret: source(commands.getSecret, (secret, _target, t) => ({
    createdAt: secret.createdAt,
    groups: [
      {
        title: t("columns", "type"),
        items: [
          { label: t("columns", "type"), value: secret.type, mono: true },
        ],
      },
      {
        // Names only. A peek is read over someone's shoulder; the values
        // stay behind the detail page's explicit reveal.
        title: t("columns", "keys"),
        count: secret.dataKeys.length,
        items: secret.dataKeys.map((key) => ({
          label: key,
          value: "",
          mono: true,
        })),
        emptyMessage: t("empty", "noKeys"),
      },
    ],
  })),

  PersistentVolumeClaim: source(
    commands.getPersistentVolumeClaim,
    (claim, _target, t) => ({
      status: claim.status,
      createdAt: claim.createdAt,
      groups: [
        {
          title: t("nav", "storage"),
          items: [
            {
              label: t("columns", "capacity"),
              value: claim.capacity || t("empty", "notProvisionedYet"),
              mono: !!claim.capacity,
              tone: claim.capacity ? undefined : "warn",
            },
            {
              label: t("columns", "volume"),
              value: claim.volume
                ? ref("PersistentVolume", claim.volume)
                : t("empty", "notBoundYet"),
              tone: claim.volume ? undefined : "warn",
            },
            {
              label: t("columns", "storageClass"),
              value: claim.storageClass
                ? ref("StorageClass", claim.storageClass)
                : t("empty", "clusterDefault"),
            },
            {
              label: t("columns", "accessModes"),
              value: list(claim.accessModes),
              mono: true,
            },
          ],
        },
      ],
    })
  ),

  PersistentVolume: source(
    (name) => commands.getPersistentVolume(name),
    (volume, _target, t) => ({
      status: volume.status,
      createdAt: volume.createdAt,
      groups: [
        {
          title: t("nav", "storage"),
          items: [
            {
              label: t("columns", "capacity"),
              value: volume.capacity || t("empty", "nothingReportedYet"),
              mono: !!volume.capacity,
              tone: volume.capacity ? undefined : "warn",
            },
            {
              label: t("columns", "claim"),
              // The detail page and the list have used `ClaimRef` here since
              // it existed; the peek was printing the same `ns/name` as text,
              // so the same fact carried a glyph on two screens and neither
              // on the third.
              value: volume.claim ? (
                <ClaimRef claim={volume.claim} />
              ) : (
                t("action", "unbound")
              ),
            },
            {
              label: t("columns", "storageClass"),
              value: volume.storageClass
                ? ref("StorageClass", volume.storageClass)
                : t("empty", "none"),
            },
            {
              label: t("columns", "reclaimPolicy"),
              value: volume.reclaimPolicy || t("empty", "nothingReportedYet"),
              tone: volume.reclaimPolicy ? undefined : "warn",
            },
            {
              label: t("columns", "accessModes"),
              value: list(volume.accessModes),
              mono: true,
            },
            ...(volume.reason
              ? [
                  {
                    label: t("columns", "reason"),
                    value: volume.reason,
                    tone: "err" as const,
                  },
                ]
              : []),
          ],
        },
      ],
    })
  ),

  StorageClass: source(
    (name) => commands.getStorageClass(name),
    (storageClass, _target, t) => ({
      createdAt: storageClass.createdAt,
      groups: [
        {
          title: t("columns", "provisioning"),
          items: [
            {
              label: t("columns", "provisioner"),
              value: storageClass.provisioner,
              mono: true,
            },
            {
              label: t("columns", "reclaimPolicy"),
              value: storageClass.reclaimPolicy,
            },
            {
              label: t("columns", "bindingMode"),
              value: storageClass.volumeBindingMode,
            },
            {
              label: t("columns", "expansion"),
              value: storageClass.allowVolumeExpansion
                ? t("columns", "allowed")
                : t("empty", "notAllowed"),
            },
            {
              label: t("cluster", "hueDefault"),
              value: storageClass.isDefault
                ? t("action", "yes")
                : t("action", "no"),
            },
          ],
        },
      ],
    })
  ),
};
