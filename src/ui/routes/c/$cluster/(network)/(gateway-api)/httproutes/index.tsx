import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/httproutes/"
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$cluster/routes",
      params,
      search: { kind: "httproutes" },
      replace: true,
    });
  },
});
