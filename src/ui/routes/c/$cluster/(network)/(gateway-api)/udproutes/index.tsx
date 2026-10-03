import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/udproutes/"
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$cluster/routes",
      params,
      search: { kind: "udproutes" },
      replace: true,
    });
  },
});
