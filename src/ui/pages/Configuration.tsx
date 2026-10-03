import { Routes, Route } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { ConfigMapList } from "@/components/resources/ConfigMapList";
import { SecretList } from "@/components/resources/SecretList";

export function Configuration() {
  return (
    <Routes>
      <Route
        path={toPlural(ResourceType.ConfigMap)}
        element={<ConfigMapList />}
      />
      <Route path={toPlural(ResourceType.Secret)} element={<SecretList />} />
      <Route index element={<ConfigMapList />} />
    </Routes>
  );
}
