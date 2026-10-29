import { useEffect, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Button } from "./ui";
import { CalendarModal, CalendarNotice, useCalendarAction } from "./calendar-controls";

export function useCalendarSettingsDraft<T>(initial: T) {
  const [value, setValue] = useState(initial),
    [saved, setSaved] = useState(() => JSON.stringify(initial));
  const dirty = JSON.stringify(value) !== saved;
  const replace = (next: T) => {
    setValue(next);
    setSaved(JSON.stringify(next));
  };
  useEffect(() => {
    if (!dirty) replace(initial);
  }, [JSON.stringify(initial)]);
  return {
    value,
    setValue,
    dirty,
    reset: () => {
      setValue(JSON.parse(saved) as T);
    },
    replace,
  };
}

export function CalendarSettingsForm({
  children,
  dirty,
  onSave,
  onReset,
  label = "Save changes",
}: {
  children: ReactNode;
  dirty: boolean;
  onSave: () => Promise<void>;
  onReset: () => void;
  label?: string;
}) {
  const action = useCalendarAction();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (dirty || action.busy) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty && !action.busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, action.busy]);
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(onSave);
        }}
      >
        <fieldset className="calendar-settings-fieldset" disabled={action.busy}>
          {children}
        </fieldset>
        <CalendarNotice error={action.error} />
        <div className="calendar-settings-save">
          <span role="status">
            {action.busy ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <Button variant="ghost" disabled={!dirty || action.busy} onClick={onReset}>
            Reset changes
          </Button>
          <Button variant="primary" type="submit" disabled={!dirty || action.busy}>
            {action.busy ? "Saving…" : label}
          </Button>
        </div>
      </form>
      {blocker.state === "blocked" && (
        <CalendarModal
          title="Save changes before leaving?"
          description="This page has unsaved changes."
          onClose={() => blocker.reset()}
          busy={action.busy}
        >
          <CalendarNotice error={action.error} />
          <div className="calendar-dialog-actions">
            <Button variant="ghost" disabled={action.busy} onClick={() => blocker.reset()}>
              Keep editing
            </Button>
            <Button disabled={action.busy} onClick={() => blocker.proceed()}>
              Discard changes
            </Button>
            <Button
              variant="primary"
              disabled={action.busy}
              onClick={() => {
                void action.run(onSave).then((saved) => {
                  if (saved) blocker.proceed();
                });
              }}
            >
              Save and leave
            </Button>
          </div>
        </CalendarModal>
      )}
    </>
  );
}
