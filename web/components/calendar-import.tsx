import { useRef, useState } from "react";
import { Button, Input, SelectControl } from "./ui";
import { CalendarField, CalendarModal, CalendarNotice, useCalendarAction } from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { calendarApi, calendarRank } from "../lib/calendar";
import { MailOperation } from "../lib/mail-helpers";
import { ApiError } from "../lib/api";

interface ImportResult {
  dry_run: boolean;
  events_imported: number;
  summary: { ready: number; imported: number; skipped: number; failed: number };
  entries: { index: number; uid: string; title: string; status: "ready" | "imported" | "skipped" | "error"; message: string; warnings: string[] }[];
}
export function CalendarImportDialog({ onClose }: { onClose: () => void }) {
  const calendar = useCalendar(), action = useCalendarAction();
  const destinations = calendar.data?.calendars.filter(cal => calendarRank(cal) >= 3) ?? [];
  const [calendarId, setCalendarId] = useState(destinations.find(cal => cal.is_primary)?.id ?? destinations[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null), [content, setContent] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const operation = useRef(new MailOperation());
  const preview = () => action.run(async () => {
    if (!file) return;
    if (!/\.ics$/i.test(file.name)) throw new Error("Choose an .ics calendar file.");
    if (!file.size || file.size > 1024 * 1024) throw new Error("Choose a non-empty .ics file of up to 1 MiB.");
    const bytes = await file.arrayBuffer();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("The file must use UTF-8 encoding."); }
    setContent(text);
    const report = await calendarApi<ImportResult>(`/calendars/${calendarId}/imports`, { method: "POST", body: { content: text, dry_run: true } });
    setResult(report);
  });
  const commit = () => action.run(async () => {
    const body = { content, dry_run: false };
    try {
      const report = await calendarApi<ImportResult>(`/calendars/${calendarId}/imports`, { method: "POST", body, headers: operation.current.headers({ calendarId, ...body }), signal: AbortSignal.timeout(60_000) });
      operation.current.complete(); setResult(report);
      if (report.events_imported) calendar.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) operation.current.complete();
      throw error;
    }
  });
  const reset = () => { setResult(null); setContent(""); action.setError(""); operation.current.complete(); };
  const finished = result?.dry_run === false;
  return <CalendarModal title="Import calendar events" description="Bring events from an iCalendar (.ics) file into one of your calendars." onClose={onClose} busy={action.busy} className="calendar-import-modal">
    <form onSubmit={event => { event.preventDefault(); void preview(); }}>
      {result ? <div className="calendar-import-source"><div><strong>{destinations.find(cal => cal.id === calendarId)?.name}</strong><span>{file?.name}</span></div>{!finished && <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => { reset(); setFile(null); }}>Change</Button>}</div> : <div className="calendar-settings-fields">
        <CalendarField label="Calendar"><SelectControl aria-label="Import into calendar" value={calendarId} onValueChange={value => { setCalendarId(value); reset(); }} disabled={action.busy || finished} options={destinations.map(cal => ({ value: cal.id, label: cal.name }))} /></CalendarField>
        <CalendarField label="iCalendar file" hint="UTF-8 .ics files, up to 1 MiB and 200 entries."><Input type="file" aria-label="iCalendar file" accept=".ics,text/calendar" disabled={action.busy || finished} onChange={event => { setFile(event.target.files?.[0] ?? null); reset(); }} /></CalendarField>
        <p className="calendar-import-hint">Floating times use the selected calendar’s time zone. Existing event UIDs are skipped. Guests and reminders are not imported; no invitations are sent.</p>
      </div>}
      {!destinations.length && <CalendarNotice error="You need permission to add events to a calendar before importing." />}
      <CalendarNotice error={action.error} />
      {result && <section className="calendar-import-report" aria-label={finished ? "Import result" : "Import preview"}>
        <div role="status"><h3>{finished ? "Import complete" : "Review import"}</h3><p>{finished ? `${result.events_imported} events imported · ${result.summary.imported} entries processed` : `${result.summary.ready} entries ready`} · {result.summary.skipped} skipped · {result.summary.failed} failed</p></div>
        <ol>{result.entries.map(entry => <li key={entry.index} data-status={entry.status}>
          <strong>{entry.title || entry.uid || `Entry ${entry.index}`}</strong><span>{entry.message}</span>
          {entry.warnings.map(warning => <p key={warning}>{warning}</p>)}
        </li>)}</ol>
      </section>}
      <div className="calendar-dialog-actions">
        <Button variant="ghost" disabled={action.busy} onClick={onClose}>{finished ? "Done" : "Cancel"}</Button>
        {!finished && (!result ? <Button variant="primary" type="submit" disabled={!file || !calendarId || action.busy}>{action.busy ? "Reading file…" : "Preview import"}</Button> : <Button variant="primary" disabled={!result.summary.ready || action.busy} onClick={() => { void commit(); }}>{action.busy ? "Importing…" : "Import events"}</Button>)}
      </div>
    </form>
  </CalendarModal>;
}
