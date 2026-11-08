import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { ConsolePageHeader, Notice } from "./console-shared";
import { LoadingSkeleton } from "./loading-skeleton";
import { SettingsLayout } from "./settings-layout";
import {
  Button,
  Dialog,
  DialogPopup,
  Field,
  Fieldset,
  Form,
  Icon,
  SelectControl,
  TextField,
  type InputProps,
} from "./ui";
import "./console-settings.css";

export function ConsoleSettingsLayout(props: ComponentProps<typeof SettingsLayout>) {
  return (
    <section className="account-page console-page console-settings" data-ui-theme="neutral">
      <SettingsLayout {...props} />
    </section>
  );
}

export function ConsoleDetail({
  backTo,
  backLabel,
  children,
}: {
  backTo: string;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="console-detail-page">
      <Link to={backTo} className="console-back">
        <span aria-hidden="true">←</span> {backLabel}
      </Link>
      {children}
    </div>
  );
}

export function ConsoleSettingsHeader({
  children,
  ...props
}: Omit<ComponentProps<typeof ConsolePageHeader>, "level">) {
  return (
    <ConsolePageHeader {...props} level={2}>
      {children && <div className="console-header-actions">{children}</div>}
    </ConsolePageHeader>
  );
}

export function ConsoleSection({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`account-panel console-section ${className}`}>
      {title && (
        <header className="console-section-header">
          <div>
            <h3>{title}</h3>
            {description && <p>{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function ConsoleField({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Field.Root className={`console-field ${className}`}>
      <Field.Label>{label}</Field.Label>
      {children}
      {hint && <Field.Description>{hint}</Field.Description>}
    </Field.Root>
  );
}

export function ConsoleInput({
  label,
  hint,
  fieldClassName,
  onChange,
  ...props
}: Omit<InputProps, "onChange"> & {
  label: string;
  hint?: string;
  fieldClassName?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}) {
  const dateInput = props.type === "date" || props.type === "datetime-local";
  return (
    <TextField
      {...props}
      label={label}
      description={hint}
      fieldProps={{ className: `console-field ${fieldClassName ?? ""}` }}
      onChange={onChange}
      onInput={
        dateInput
          ? (event) => {
              props.onInput?.(event);
              onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>);
            }
          : props.onInput
      }
    />
  );
}

export function ConsoleSelect({
  value = "",
  ...props
}: Omit<ComponentProps<typeof SelectControl>, "value"> & { value?: string }) {
  return (
    <SelectControl
      {...props}
      value={value}
      className={`console-select ${props.className ?? ""}`}
      theme="neutral"
    />
  );
}

export function ConsoleSelectField({
  label,
  onChange,
  ...props
}: Omit<ComponentProps<typeof ConsoleSelect>, "onValueChange"> & {
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <ConsoleField label={label}>
      <ConsoleSelect {...props} aria-label={label} onValueChange={onChange} />
    </ConsoleField>
  );
}

export function ConsoleFilters({ children }: { children: ReactNode }) {
  return <div className="console-filters">{children}</div>;
}

export function ConsoleDateFilters({
  after,
  before,
  onAfter,
  onBefore,
}: {
  after: string;
  before: string;
  onAfter: (value: string) => void;
  onBefore: (value: string) => void;
}) {
  return (
    <>
      <ConsoleInput
        label={t("consoleSettings.fromDate")}
        type="date"
        value={after}
        max={before || undefined}
        onChange={(event) => onAfter(event.target.value)}
      />
      <ConsoleInput
        label={t("consoleSettings.toDate")}
        type="date"
        value={before}
        min={after || undefined}
        onChange={(event) => onBefore(event.target.value)}
      />
    </>
  );
}

export function ConsoleForm(props: ComponentProps<typeof Form>) {
  return <Form {...props} className={`console-form ${props.className ?? ""}`} />;
}

export function ConsoleFieldset({
  sections,
  ...props
}: ComponentProps<typeof Fieldset.Root> & { sections?: boolean }) {
  return (
    <Fieldset.Root
      {...props}
      className={`${sections ? "console-form-sections" : "console-form-fields"} ${props.className ?? ""}`}
    />
  );
}

export function ConsoleState({
  loading,
  error,
  retry,
  kind = "section",
}: {
  loading: boolean;
  error: string;
  retry?: () => void;
  kind?: "section" | "list" | "form";
}) {
  return error ? (
    <div className="console-resource-error">
      <Notice error={error} />
      {retry && <Button onClick={retry}>{t("consoleSettings.retry")}</Button>}
    </div>
  ) : loading ? (
    <LoadingSkeleton kind={kind} label={t("common.loading")} rows={kind === "list" ? 5 : 3} />
  ) : null;
}

export function ConsolePagination({
  page,
  count,
  hasNext,
  loading,
  previous,
  next,
}: {
  page: number;
  count: number;
  hasNext: boolean;
  loading: boolean;
  previous: () => void;
  next: () => void;
}) {
  return (
    <div className="console-pagination">
      <span>{t("consoleSettings.pageResults", { page, count })}</span>
      <div>
        <Button size="sm" disabled={page === 1 || loading} onClick={previous}>
          {t("common.previous")}
        </Button>
        <Button size="sm" disabled={!hasNext || loading} onClick={next}>
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}

export function ConsoleTable<T>({
  resource,
  headings,
  children,
  empty = t("consoleSettings.noRecords"),
}: {
  resource: {
    data: { items: T[]; next_cursor: string | null } | null;
    loading: boolean;
    error: string;
    reload: () => void;
    page: number;
    previous: () => void;
    next: () => void;
  };
  headings: string[];
  children: ReactNode;
  empty?: string;
}) {
  return (
    <>
      <ConsoleState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
        kind="list"
      />
      {resource.data && (
        <section className="account-panel console-list-panel" aria-busy={resource.loading}>
          <div
            className="console-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("consoleSettings.records")}
          >
            <table
              className="console-table console-settings-table"
              data-actions={headings.at(-1) === t("common.actions")}
            >
              <thead>
                <tr>
                  {headings.map((heading, index) => (
                    <th scope="col" key={index}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{children}</tbody>
            </table>
            {!resource.data.items.length && <p className="console-empty">{empty}</p>}
          </div>
          <ConsolePagination
            page={resource.page}
            count={resource.data.items.length}
            hasNext={!!resource.data.next_cursor}
            loading={resource.loading}
            previous={resource.previous}
            next={resource.next}
          />
        </section>
      )}
    </>
  );
}

export function ConsoleMetrics({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="console-metrics">
      {items.map(({ label, value }) => (
        <ConsoleSection key={label} title={label} className="console-metric">
          <p>{value}</p>
        </ConsoleSection>
      ))}
    </div>
  );
}

export function ConsoleFormActions({ children, meta }: { children?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="console-form-actions">
      {meta && <span className="console-subtext">{meta}</span>}
      {children && <div className="account-actions">{children}</div>}
    </div>
  );
}

export function ConsoleDialog({
  open,
  title,
  description,
  children,
  onClose,
  busy,
  wide,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="console-dialog" data-wide={wide} data-ui-theme="neutral">
        <div className="console-dialog-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("common.close")}
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="close" />
          </Button>
        </div>
        <Dialog.Description render={<div />}>{description}</Dialog.Description>
        {children}
      </DialogPopup>
    </Dialog.Root>
  );
}
