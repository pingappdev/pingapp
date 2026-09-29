import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/logout")({
  beforeLoad: () => { throw redirect({ to: "/" }); },
});
