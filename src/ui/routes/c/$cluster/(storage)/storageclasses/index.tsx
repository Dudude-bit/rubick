import { createFileRoute } from "@tanstack/react-router";
import { StorageClassList } from "./-components/StorageClassList";

export const Route = createFileRoute("/c/$cluster/(storage)/storageclasses/")({
  component: StorageClassList,
});
