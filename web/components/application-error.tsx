import { Component, useEffect, useId, useRef, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../shared/i18n/index.ts";
import { isModuleLoadError } from "../lib/application-error.ts";
import { Button } from "./ui/button";
import { Icon, OfficeflareMark } from "./ui/icon";
import "./application-error.css";

export function ApplicationErrorPage({
  error,
  notFound = false,
}: {
  error?: unknown;
  notFound?: boolean;
}) {
  const moduleError = isModuleLoadError(error);
  const title = notFound
    ? t("main.pageNotFound")
    : moduleError
      ? t("applicationError.loadTitle")
      : t("applicationError.unexpectedTitle");
  const description = notFound
    ? t("main.checkTheAddressOrReturnToYourWorkspace")
    : moduleError
      ? t("applicationError.loadDescription")
      : t("applicationError.unexpectedDescription");
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · ${t("common.officeflare")}`;
    heading.current?.focus();
  }, [title]);
  return (
    <div className="application-error-page" data-ui-theme="neutral">
      <header className="application-error-header">
        <a href="/" className="application-error-brand">
          <OfficeflareMark />
          {t("common.officeflare")}
        </a>
      </header>
      <main className="application-error-content" aria-labelledby={headingId}>
        <div className="application-error-card">
          <div className="application-error-symbol">
            <Icon name={moduleError ? "refresh" : "info"} width="24" height="24" />
          </div>
          <h1 id={headingId} ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p>{description}</p>
          <div className="application-error-actions">
            {!notFound && (
              <Button variant="primary" onClick={() => window.location.reload()}>
                <Icon name="refresh" />
                {t("common.refresh")}
              </Button>
            )}
            <Button nativeButton={false} role="link" render={<a href="/" />}>
              {t("main.returnToWorkspace")}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

export class ApplicationErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Application rendering failed", error, info.componentStack);
  }
  render() {
    return this.state.failed ? (
      <ApplicationErrorPage error={this.state.error} />
    ) : (
      this.props.children
    );
  }
}
