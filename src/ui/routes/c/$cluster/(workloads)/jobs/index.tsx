import { createFileRoute } from "@tanstack/react-router";
import { JobList } from "@/components/resources/JobList";

export const Route = createFileRoute("/c/$cluster/(workloads)/jobs/")({
  component: JobList,
});
