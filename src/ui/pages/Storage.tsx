import { Routes, Route } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { PersistentVolumeList } from "@/components/resources/PersistentVolumeList";
import { PersistentVolumeClaimList } from "@/components/resources/PersistentVolumeClaimList";
import { StorageClassList } from "@/components/resources/StorageClassList";

export function Storage() {
  return (
    <Routes>
      <Route
        path={toPlural(ResourceType.PersistentVolume)}
        element={<PersistentVolumeList />}
      />
      <Route
        path={toPlural(ResourceType.PersistentVolumeClaim)}
        element={<PersistentVolumeClaimList />}
      />
      <Route
        path={toPlural(ResourceType.StorageClass)}
        element={<StorageClassList />}
      />
      <Route index element={<PersistentVolumeList />} />
    </Routes>
  );
}
