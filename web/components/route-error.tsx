import { isRouteErrorResponse, useRouteError } from "react-router";
import { ApplicationErrorPage } from "./application-error";

export function RouteErrorBoundary() {
  const error = useRouteError();
  return (
    <ApplicationErrorPage
      error={error}
      notFound={isRouteErrorResponse(error) && error.status === 404}
    />
  );
}
