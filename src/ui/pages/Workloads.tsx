import { Routes, Route } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { PodList } from "@/components/resources/PodList";
import { DeploymentList } from "@/components/resources/DeploymentList";
import { StatefulSetList } from "@/components/resources/StatefulSetList";
import { DaemonSetList } from "@/components/resources/DaemonSetList";
import { JobList } from "@/components/resources/JobList";
import { CronJobList } from "@/components/resources/CronJobList";

export function Workloads() {
  return (
    <Routes>
      <Route path={toPlural(ResourceType.Pod)} element={<PodList />} />
      <Route
        path={toPlural(ResourceType.Deployment)}
        element={<DeploymentList />}
      />
      <Route
        path={toPlural(ResourceType.StatefulSet)}
        element={<StatefulSetList />}
      />
      <Route
        path={toPlural(ResourceType.DaemonSet)}
        element={<DaemonSetList />}
      />
      <Route path={toPlural(ResourceType.Job)} element={<JobList />} />
      <Route path={toPlural(ResourceType.CronJob)} element={<CronJobList />} />
      <Route index element={<PodList />} />
    </Routes>
  );
}
