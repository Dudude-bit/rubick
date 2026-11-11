import { createFileRoute } from "@tanstack/react-router";

import { FrontDoorRoute } from "./-components/FrontDoorRoute";

export const Route = createFileRoute("/")({
  component: FrontDoorRoute,
});
