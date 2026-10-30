import { t } from "../../shared/i18n/index.ts";
import { Button, OfficeflareMark, Progress } from "./ui";

export function WorkspaceLoading({
  error = "",
  onRetry,
}: {
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <main
      className="workspace-loading"
      data-ui-theme="neutral"
      data-error={!!error || undefined}
      aria-busy={!error}
    >
      <div className="workspace-loading-content">
        <OfficeflareMark className="workspace-loading-symbol" />
        <Progress.Root
          value={null}
          aria-label={t("componentsWorkspaceLoading.loadingOfficeflare")}
          className="workspace-loading-progress"
        >
          <Progress.Track>
            <Progress.Indicator />
          </Progress.Track>
        </Progress.Root>
        {error && (
          <div className="workspace-loading-error" role="alert">
            <p>{error}</p>
            {onRetry && (
              <Button onClick={onRetry}>{t("componentsWorkspaceLoading.tryAgain")}</Button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
