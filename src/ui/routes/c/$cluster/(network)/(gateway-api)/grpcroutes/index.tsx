import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/grpcroutes/"
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$cluster/routes",
      params,
      search: { kind: "grpcroutes" },
      replace: true,
    });
  },
});
