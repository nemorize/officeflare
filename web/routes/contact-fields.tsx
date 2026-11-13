import { useRef, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, ApiError } from "../lib/api";
import { MailOperation } from "../lib/mail-helpers";
import {
  contactFieldTypes,
  type ContactFieldDefinition,
  type ContactFieldType,
} from "../lib/contact-model";
import { useContacts } from "../components/contacts-context";
import {
  ContactField,
  ContactModal,
  ContactNotice,
  useContactAction,
} from "../components/contacts-controls";
import { Confirm, ConsolePageHeader } from "../components/console-shared";
import { SettingsSection } from "../components/settings-layout";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { Button, Icon, SelectControl, Textarea, useNotifications } from "../components/ui";

const typeLabels = {
  text: "contacts.textType",
  number: "contacts.numberType",
  boolean: "contacts.booleanType",
  date: "contacts.dateType",
  url: "contacts.urlType",
  select: "contacts.selectType",
  multiselect: "contacts.multiselectType",
} as const;
export function ContactFieldsPage() {
  const contacts = useContacts(),
    notify = useNotifications(),
    action = useContactAction(),
    [editor, setEditor] = useState<{ field?: ContactFieldDefinition } | null>(null),
    [archiving, setArchiving] = useState<ContactFieldDefinition | null>(null);
  const render = (archived: boolean) => {
    const fields = contacts.fields.filter((field) => !!field.archived_at === archived);
    if (!fields.length) return null;
    return (
      <SettingsSection title={t(archived ? "contacts.archivedFields" : "contacts.activeFields")}>
        <div className="settings-record-list">
          {fields.map((field) => (
            <div key={field.id} className="settings-record contacts-definition-row">
              <div>
                <strong>{field.label}</strong>
                <span>
                  {t(typeLabels[field.value_type])}
                  {field.options.length ? ` · ${field.options.join(", ")}` : ""}
                </span>
              </div>
              {contacts.can("fields.manage") && (
                <div className="settings-actions">
                  {archived ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api(`/api/contacts/field-definitions/${field.id}`, {
                            method: "PATCH",
                            body: { version: field.version, archived: false },
                          });
                          contacts.refresh();
                          notify.success(t("contacts.fieldSaved"));
                        })
                      }
                    >
                      {t("contacts.restoreField")}
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditor({ field })}>
                        {t("common.edit")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setArchiving(field)}>
                        {t("contacts.archiveField")}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
    );
  };
  return (
    <div className="account-page settings-page contacts-fields-page">
      <ConsolePageHeader
        title={t("contacts.customFields")}
        description={t("contacts.customDescription")}
      >
        {contacts.can("fields.manage") && (
          <Button
            variant="primary"
            disabled={contacts.loading || !!contacts.error}
            onClick={() => setEditor({})}
          >
            <Icon name="plus" />
            {t("contacts.newField")}
          </Button>
        )}
      </ConsolePageHeader>
      <ContactNotice error={contacts.error} retry={contacts.refresh} />
      <ContactNotice error={action.error} />
      {contacts.loading && !contacts.fields.length ? (
        <LoadingSkeleton rows={4} />
      ) : !contacts.error && !contacts.fields.length ? (
        <div className="contacts-empty">
          <Icon name="controls" width={36} height={36} />
          <h2>{t("contacts.emptyFields")}</h2>
          <p>{t("contacts.customDescription")}</p>
        </div>
      ) : (
        <>
          {render(false)}
          {render(true)}
        </>
      )}
      {editor && (
        <FieldEditor
          field={editor.field}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            contacts.refresh();
            notify.success(t("contacts.fieldSaved"));
          }}
        />
      )}
      {archiving && (
        <Confirm
          open
          title={t("contacts.archiveField")}
          description={t("contacts.archiveDescription", { name: archiving.label })}
          label={t("contacts.archiveField")}
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            await api(
              `/api/contacts/field-definitions/${archiving.id}?version=${archiving.version}`,
              { method: "DELETE" },
            );
            contacts.refresh();
            notify.success(t("contacts.fieldArchived"));
          }}
        />
      )}
    </div>
  );
}
function FieldEditor({
  field,
  onClose,
  onSaved,
}: {
  field?: ContactFieldDefinition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(field?.label ?? ""),
    [type, setType] = useState<ContactFieldType>(field?.value_type ?? "text"),
    [options, setOptions] = useState(field?.options.join("\n") ?? ""),
    action = useContactAction(),
    operation = useRef(new MailOperation());
  const key = useRef(
    field?.key ??
      `field_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) => value.toString(16).padStart(2, "0")).join("")}`,
  );
  return (
    <ContactModal
      title={t(field ? "contacts.editField" : "contacts.newField")}
      onClose={onClose}
      busy={action.busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void action.run(async () => {
            const body = {
              label: label.trim(),
              value_type: type,
              options: ["select", "multiselect"].includes(type)
                ? options
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean)
                : [],
              ...(field ? { version: field.version } : { key: key.current }),
            };
            try {
              await api(
                field
                  ? `/api/contacts/field-definitions/${field.id}`
                  : "/api/contacts/field-definitions",
                {
                  method: field ? "PATCH" : "POST",
                  body,
                  headers: operation.current.headers(body),
                },
              );
              operation.current.complete();
              onSaved();
            } catch (failure) {
              if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
              throw failure;
            }
          });
        }}
      >
        <fieldset className="contact-dialog-body" disabled={action.busy}>
          <ContactField
            label={t("contacts.fieldName")}
            autoFocus
            required
            value={label}
            maxLength={255}
            onChange={(event) => setLabel(event.target.value)}
          />
          <ContactField label={t("contacts.fieldType")}>
            <SelectControl
              aria-label={t("contacts.fieldType")}
              value={type}
              onValueChange={(next) => setType(next as ContactFieldType)}
              options={contactFieldTypes.map((value) => ({ value, label: t(typeLabels[value]) }))}
            />
          </ContactField>
          {["select", "multiselect"].includes(type) && (
            <ContactField label={t("contacts.fieldOptions")}>
              <Textarea
                rows={5}
                required
                maxLength={25000}
                value={options}
                onChange={(event) => setOptions(event.target.value)}
              />
            </ContactField>
          )}
          {field && <p className="contacts-field-hint">{t("contacts.fieldHint")}</p>}
          <ContactNotice error={action.error} />
        </fieldset>
        <footer>
          <Button variant="ghost" disabled={action.busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={action.busy || !label.trim()}>
            {t("common.save")}
          </Button>
        </footer>
      </form>
    </ContactModal>
  );
}
