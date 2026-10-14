import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/components/ui";
import { api, errorMessage } from "../lib/api";
interface Invitation {
  attendee: {
    id: string;
    version: number;
    response_status?: string;
    occurrence_key?: string;
  };
  event: {
    title?: string;
    status: string;
    start?: { date?: string; date_time?: string };
    end?: { date?: string; date_time?: string };
    location?: { label?: string };
  };
  is_revoked: boolean;
}
export function CalendarInvitationPage() {
  const { attendeeId } = useParams(),
    path = `/api/calendar/inbox-invitations/${encodeURIComponent(attendeeId ?? "")}`,
    [value, setValue] = useState<Invitation | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<Invitation>(path, { signal: controller.signal })
      .then(setValue)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [path]);
  async function respond(response_status: string) {
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(path + "/rsvp", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { version: value.attendee.version, response_status },
      });
      setValue(await api<Invitation>(path));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{value?.event.title ?? "Calendar invitation"}</h1>
        <p>
          {value?.is_revoked
            ? "This invitation is no longer available."
            : value
              ? `${value.event.start?.date ?? value.event.start?.date_time ?? ""} – ${value.event.end?.date ?? value.event.end?.date_time ?? ""}`
              : "Loading invitation…"}
        </p>
      </header>
      <section className="account-panel">
        {error && (
          <p className="account-notice" data-error role="alert">
            {error}
          </p>
        )}
        {value && !value.is_revoked && (
          <>
            <p>{value.event.location?.label}</p>
            <p>Your response: {value.attendee.response_status}</p>
            <div className="account-actions">
              {[
                ["accepted", "Attend"],
                ["tentative", "Maybe"],
                ["declined", "Decline"],
              ].map(([status, label]) => (
                <Button
                  key={status}
                  disabled={busy}
                  onClick={() => {
                    void respond(status!);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </>
        )}
      </section>
    </section>
  );
}
