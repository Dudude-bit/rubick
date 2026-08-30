import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "../components/not-found";

export const Route = createFileRoute("/404")({
  head: () => ({
    meta: [
      { title: "404, this page does not exist" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NotFound,
});
