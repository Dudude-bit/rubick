/**
 * Container Configuration Component
 *
 * Combines EnvironmentVariables, VolumeMounts, and ImagePullSecrets
 * into a unified "Configuration" view for a container.
 */

import { EnvironmentVariables } from "./EnvironmentVariables";
import { VolumeMounts } from "./VolumeMounts";
import { ImagePullSecrets } from "./ImagePullSecrets";
import type {
  EnvVarInfo,
  EnvFromInfo,
  VolumeReference,
} from "@/generated/types";

interface ContainerConfigurationProps {
  env: EnvVarInfo[];
  envFrom: EnvFromInfo[];
  volumes: VolumeReference[];
  imagePullSecrets: string[];
  containerName?: string;
  namespace?: string;
}

export function ContainerConfiguration({
  env,
  envFrom,
  volumes,
  imagePullSecrets,
  containerName,
  namespace,
}: ContainerConfigurationProps) {
  return (
    <div className="flex flex-col gap-[22px]">
      <EnvironmentVariables
        env={env}
        envFrom={envFrom}
        containerName={containerName}
        namespace={namespace}
      />
      <VolumeMounts volumes={volumes} namespace={namespace} />
      <ImagePullSecrets secrets={imagePullSecrets} namespace={namespace} />
    </div>
  );
}
