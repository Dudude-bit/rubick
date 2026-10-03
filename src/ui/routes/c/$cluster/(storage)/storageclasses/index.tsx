import { createFileRoute } from "@tanstack/react-router";
import { StorageClassList } from "@/components/resources/StorageClassList";

export const Route = createFileRoute("/c/$cluster/(storage)/storageclasses/")({
  component: StorageClassList,
});
