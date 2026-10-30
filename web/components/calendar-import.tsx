import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useRef, useState } from "react";
import { Button, Input, SelectControl } from "./ui";
import {
  CalendarField,
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
} from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { calendarApi, calendarWritable } from "../lib/calendar";
import { MailOperation } from "../lib/mail-helpers";
import { ApiError } from "../lib/api";

interface ImportResult {
  dry_run: boolean;
  events_imported: number;
  summary: { ready: number; imported: number; skipped: number; failed: number };
  entries: {
    index: number;
    uid: string;
    title: string;
    status: "ready" | "imported" | "skipped" | "error";
    message: string;
    warnings: string[];
  }[];
}
export function CalendarImportDialog({ onClose }: { onClose: () => void }) {
  const calendar = useCalendar(),
    action = useCalendarAction();
  const destinations = calendar.data?.calendars.filter((cal) => calendarWritable(cal)) ?? [];
  const [calendarId, setCalendarId] = useState(
    destinations.find((cal) => cal.is_primary)?.id ?? destinations[0]?.id ?? "",
  );
  const [file, setFile] = useState<File | null>(null),
    [content, setContent] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const operation = useRef(new MailOperation());
  const preview = () =>
    action.run(async () => {
      if (!file) return;
      if (!/\.ics$/i.test(file.name))
        throw new Error(t("componentsCalendarImport.chooseAnIcsCalendarFile"));
      if (!file.size || file.size > 1024 * 1024)
        throw new Error(t("componentsCalendarImport.chooseANonEmptyIcsFileOfUpTo"));
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(t("componentsCalendarImport.theFileMustUseUtf8Encoding"));
      }
      setContent(text);
      const report = await calendarApi<ImportResult>(`/calendars/${calendarId}/imports`, {
        method: "POST",
        body: { content: text, dry_run: true },
      });
      setResult(report);
    });
  const commit = () =>
    action.run(async () => {
      const body = { content, dry_run: false };
      try {
        const report = await calendarApi<ImportResult>(`/calendars/${calendarId}/imports`, {
          method: "POST",
          body,
          headers: operation.current.headers({ calendarId, ...body }),
          signal: AbortSignal.timeout(60_000),
        });
        operation.current.complete();
        setResult(report);
        if (report.events_imported) calendar.refresh();
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) operation.current.complete();
        throw error;
      }
    });
  const reset = () => {
    setResult(null);
    setContent("");
    action.setError("");
    operation.current.complete();
  };
  const finished = result?.dry_run === false;
  return (
    <CalendarModal
      title={t("componentsCalendarImport.importCalendarEvents")}
      description={t("componentsCalendarImport.bringEventsFromAnIcalendarIcsFileIntoOne")}
      onClose={onClose}
      busy={action.busy}
      className="calendar-import-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void preview();
        }}
      >
        {result ? (
          <div className="calendar-import-source">
            <div>
              <strong>{destinations.find((cal) => cal.id === calendarId)?.name}</strong>
              <span>{file?.name}</span>
            </div>
            {!finished && (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy}
                onClick={() => {
                  reset();
                  setFile(null);
                }}
              >
                {t("componentsCalendarImport.change")}
              </Button>
            )}
          </div>
        ) : (
          <div className="calendar-settings-fields">
            <CalendarField label={t("componentsCalendarImport.calendar")}>
              <SelectControl
                aria-label={t("componentsCalendarImport.importIntoCalendar")}
                value={calendarId}
                onValueChange={(value) => {
                  setCalendarId(value);
                  reset();
                }}
                disabled={action.busy || finished}
                options={destinations.map((cal) => ({ value: cal.id, label: cal.name }))}
              />
            </CalendarField>
            <CalendarField
              label={t("componentsCalendarImport.icalendarFile")}
              hint={t("componentsCalendarImport.utf8IcsFilesUpTo1MibAnd")}
            >
              <Input
                type="file"
                aria-label={t("componentsCalendarImport.icalendarFile")}
                accept=".ics,text/calendar"
                disabled={action.busy || finished}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  reset();
                }}
              />
            </CalendarField>
            <p className="calendar-import-hint">
              {t("componentsCalendarImport.floatingTimesUseTheSelectedCalendarSTimeZone")}
            </p>
          </div>
        )}
        {!destinations.length && (
          <CalendarNotice
            error={t("componentsCalendarImport.youNeedPermissionToAddEventsToACalendar")}
          />
        )}
        <CalendarNotice error={action.error} />
        {result && (
          <section
            className="calendar-import-report"
            aria-label={
              finished
                ? t("componentsCalendarImport.importResult")
                : t("componentsCalendarImport.importPreview")
            }
          >
            <div role="status">
              <h3>
                {finished
                  ? t("componentsCalendarImport.importComplete")
                  : t("componentsCalendarImport.reviewImport")}
              </h3>
              <p>
                <LocalizedMessage
                  id="componentsCalendarImport.skippedFailed"
                  values={{
                    value1: finished
                      ? t("componentsCalendarImport.eventsImportedEntriesProcessed", {
                          events_imported: result.events_imported,
                          imported: result.summary.imported,
                        })
                      : t("componentsCalendarImport.entriesReady", { ready: result.summary.ready }),
                    skipped: result.summary.skipped,
                    failed: result.summary.failed,
                  }}
                />
              </p>
            </div>
            <ol>
              {result.entries.map((entry) => (
                <li key={entry.index} data-status={entry.status}>
                  <strong>
                    {entry.title ||
                      entry.uid ||
                      t("componentsCalendarImport.entry", { index: entry.index })}
                  </strong>
                  <span>{entry.message}</span>
                  {entry.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="calendar-dialog-actions">
          <Button variant="ghost" disabled={action.busy} onClick={onClose}>
            {finished ? t("common.done") : t("common.cancel")}
          </Button>
          {!finished &&
            (!result ? (
              <Button
                variant="primary"
                type="submit"
                disabled={!file || !calendarId || action.busy}
              >
                {action.busy
                  ? t("componentsCalendarImport.readingFile")
                  : t("componentsCalendarImport.previewImport")}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!result.summary.ready || action.busy}
                onClick={() => {
                  void commit();
                }}
              >
                {action.busy
                  ? t("componentsCalendarImport.importing")
                  : t("componentsCalendarImport.importEvents")}
              </Button>
            ))}
        </div>
      </form>
    </CalendarModal>
  );
}
