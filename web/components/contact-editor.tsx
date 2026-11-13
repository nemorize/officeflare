import { useRef, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, ApiError } from "../lib/api";
import { MailOperation } from "../lib/mail-helpers";
import {
  contactDraft,
  contactPayload,
  folderOptions,
  type ContactDraft,
  type ContactRecord,
  type ContactFolder,
  type ContactFieldDefinition,
  type ContactValue,
} from "../lib/contact-model";
import { Button, CheckboxControl, Icon, Radio, RadioGroup, SelectControl, Textarea } from "./ui";
import { Confirm } from "./console-shared";
import {
  ContactField,
  ContactIconButton,
  ContactModal,
  ContactNotice,
  useContactAction,
} from "./contacts-controls";

function ValueList<T extends ContactValue>({
  title,
  addLabel,
  values,
  onChange,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  values: T[];
  onChange: (values: T[]) => void;
  onAdd: () => void;
  children: (value: T, patch: (changes: Partial<T>) => void) => ReactNode;
}) {
  return (
    <section className="contact-editor-section">
      <h3>{title}</h3>
      <RadioGroup
        className="contact-primary-group"
        aria-label={`${title} · ${t("contacts.primary")}`}
        value={String(
          Math.max(
            0,
            values.findIndex((item) => item.is_primary),
          ),
        )}
        onValueChange={(next) =>
          onChange(values.map((item, index) => ({ ...item, is_primary: index === Number(next) })))
        }
      >
        {values.map((value, index) => (
          <div className="contact-value-editor" key={value.id ?? value.draft_key ?? index}>
            <div className="contact-value-inputs">
              {children(value, (changes) =>
                onChange(
                  values.map((item, position) =>
                    position === index ? { ...item, ...changes } : item,
                  ),
                ),
              )}
            </div>
            <div className="contact-value-meta">
              <ContactField
                label={t("contacts.label")}
                value={value.label}
                placeholder={t("contacts.labelPlaceholder")}
                maxLength={100}
                onChange={(event) =>
                  onChange(
                    values.map((item, position) =>
                      position === index ? { ...item, label: event.target.value } : item,
                    ),
                  )
                }
              />
              <label className="contact-primary">
                <Radio.Root value={String(index)}>
                  <Radio.Indicator aria-hidden="true" />
                </Radio.Root>
                {t("contacts.primary")}
              </label>
              <ContactIconButton
                icon="close"
                label={t("contacts.removeValue", { label: title, index: index + 1 })}
                onClick={() => onChange(values.filter((_, position) => position !== index))}
              />
            </div>
          </div>
        ))}
      </RadioGroup>
      <Button variant="ghost" size="sm" disabled={values.length >= 50} onClick={onAdd}>
        <Icon name="plus" />
        {addLabel}
      </Button>
    </section>
  );
}
function CustomInput({
  definition,
  value,
  onChange,
}: {
  definition: ContactFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (definition.archived_at)
    return (
      <div className="contact-archived-value">
        <span>
          {definition.label} <small>{t("contacts.archived")}</small>
        </span>
        <p>
          {typeof value === "boolean"
            ? t(value ? "contacts.yes" : "contacts.no")
            : Array.isArray(value)
              ? value.join(", ")
              : String(value ?? "")}
        </p>
      </div>
    );
  if (definition.value_type === "boolean")
    return (
      <ContactField label={definition.label}>
        <SelectControl
          aria-label={definition.label}
          value={value === undefined ? "unset" : String(value)}
          onValueChange={(next) => onChange(next === "unset" ? undefined : next === "true")}
          options={[
            { value: "unset", label: t("contacts.notSet") },
            { value: "true", label: t("contacts.yes") },
            { value: "false", label: t("contacts.no") },
          ]}
        />
      </ContactField>
    );
  if (definition.value_type === "select")
    return (
      <ContactField label={definition.label}>
        <SelectControl
          aria-label={definition.label}
          value={String(value ?? "")}
          onValueChange={onChange}
          options={[
            { value: "", label: t("contacts.notSet") },
            ...definition.options.map((option) => ({ value: option, label: option })),
          ]}
        />
      </ContactField>
    );
  if (definition.value_type === "multiselect")
    return (
      <fieldset className="contact-choice-field">
        <legend>{definition.label}</legend>
        {definition.options.map((option) => (
          <label key={option}>
            <CheckboxControl
              checked={Array.isArray(value) && value.includes(option)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...(Array.isArray(value) ? value : []), option]
                    : (Array.isArray(value) ? value : []).filter((entry) => entry !== option),
                )
              }
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  return (
    <ContactField
      label={definition.label}
      type={
        definition.value_type === "number"
          ? "number"
          : definition.value_type === "date"
            ? "date"
            : definition.value_type === "url"
              ? "url"
              : "text"
      }
      step={definition.value_type === "number" ? "any" : undefined}
      maxLength={definition.value_type === "text" ? 10000 : 2048}
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
export function ContactEditor({
  contact,
  folder,
  folders,
  definitions,
  onClose,
  onSaved,
}: {
  contact?: ContactRecord;
  folder: string | null;
  folders: ContactFolder[];
  definitions: ContactFieldDefinition[];
  onClose: () => void;
  onSaved: (contact: ContactRecord) => void;
}) {
  const [draft, setDraft] = useState(() => contactDraft(contact, folder)),
    [discard, setDiscard] = useState(false),
    original = useRef(JSON.stringify(draft)),
    operation = useRef(new MailOperation()),
    counter = useRef(0),
    action = useContactAction();
  const set = <K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const close = () => {
    if (!action.busy) {
      if (JSON.stringify(draft) !== original.current) setDiscard(true);
      else onClose();
    }
  };
  const common = () => ({
    label: "",
    is_primary: false,
    sort_order: 0,
    draft_key: `new-${++counter.current}`,
  });
  const save = () =>
    action.run(async () => {
      const body = {
        ...contactPayload(draft, definitions),
        ...(contact ? { version: contact.version } : {}),
      };
      try {
        const result = await api<{ contact: ContactRecord }>(
          contact ? `/api/contacts/${contact.id}` : "/api/contacts",
          { method: contact ? "PATCH" : "POST", body, headers: operation.current.headers(body) },
        );
        operation.current.complete();
        onSaved(result.contact);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
        throw failure;
      }
    });
  return (
    <>
      <ContactModal
        title={t(contact ? "contacts.editContact" : "contacts.newContact")}
        busy={action.busy}
        onClose={close}
        className="contact-editor-dialog"
      >
        <form
          aria-busy={action.busy}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }}
        >
          <div className="contact-editor-scroll">
            <fieldset disabled={action.busy} className="contact-editor-body">
              <section className="contact-editor-section">
                <h3>{t("contacts.basicDetails")}</h3>
                <ContactField
                  label={t("contacts.name")}
                  value={draft.display_name}
                  maxLength={255}
                  autoFocus
                  onChange={(event) => set("display_name", event.target.value)}
                />
                <div className="contact-form-grid">
                  <ContactField
                    label={t("contacts.givenName")}
                    value={draft.given_name}
                    maxLength={255}
                    onChange={(event) => set("given_name", event.target.value)}
                  />
                  <ContactField
                    label={t("contacts.familyName")}
                    value={draft.family_name}
                    maxLength={255}
                    onChange={(event) => set("family_name", event.target.value)}
                  />
                </div>
                <ContactField label={t("contacts.folder")}>
                  <SelectControl
                    aria-label={t("contacts.folder")}
                    options={folderOptions(folders)}
                    value={draft.folder_id ?? "root"}
                    onValueChange={(value) => set("folder_id", value === "root" ? null : value)}
                  />
                </ContactField>
              </section>
              <ValueList
                title={t("contacts.emails")}
                addLabel={t("contacts.addEmail")}
                values={draft.emails}
                onChange={(values) => set("emails", values)}
                onAdd={() => set("emails", [...draft.emails, { ...common(), email_address: "" }])}
              >
                {(value, patch) => (
                  <ContactField
                    label={t("contacts.email")}
                    type="email"
                    maxLength={254}
                    value={value.email_address}
                    onChange={(event) => patch({ email_address: event.target.value })}
                  />
                )}
              </ValueList>
              <ValueList
                title={t("contacts.phones")}
                addLabel={t("contacts.addPhone")}
                values={draft.phones}
                onChange={(values) => set("phones", values)}
                onAdd={() =>
                  set("phones", [...draft.phones, { ...common(), phone_number: "", extension: "" }])
                }
              >
                {(value, patch) => (
                  <div className="contact-phone-input">
                    <ContactField
                      label={t("contacts.phone")}
                      type="tel"
                      maxLength={100}
                      value={value.phone_number}
                      onChange={(event) => patch({ phone_number: event.target.value })}
                    />
                    <ContactField
                      label={t("contacts.extension")}
                      maxLength={20}
                      value={value.extension}
                      onChange={(event) => patch({ extension: event.target.value })}
                    />
                  </div>
                )}
              </ValueList>
              <section className="contact-editor-section">
                <h3>{t("contacts.organization")}</h3>
                <ContactField
                  label={t("contacts.organization")}
                  value={draft.organization}
                  maxLength={255}
                  onChange={(event) => set("organization", event.target.value)}
                />
                <div className="contact-form-grid">
                  <ContactField
                    label={t("contacts.department")}
                    value={draft.department}
                    maxLength={255}
                    onChange={(event) => set("department", event.target.value)}
                  />
                  <ContactField
                    label={t("contacts.jobTitle")}
                    value={draft.job_title}
                    maxLength={255}
                    onChange={(event) => set("job_title", event.target.value)}
                  />
                </div>
              </section>
              <ValueList
                title={t("contacts.addresses")}
                addLabel={t("contacts.addAddress")}
                values={draft.addresses}
                onChange={(values) => set("addresses", values)}
                onAdd={() =>
                  set("addresses", [
                    ...draft.addresses,
                    {
                      ...common(),
                      country_code: "",
                      city: "",
                      region: "",
                      postal_code: "",
                      street_address: "",
                      extended_address: "",
                      formatted_address: "",
                    },
                  ])
                }
              >
                {(value, patch) => (
                  <>
                    <ContactField
                      label={t("contacts.streetAddress")}
                      maxLength={1024}
                      value={value.street_address}
                      onChange={(event) => patch({ street_address: event.target.value })}
                    />
                    <ContactField
                      label={t("contacts.extendedAddress")}
                      maxLength={1024}
                      value={value.extended_address}
                      onChange={(event) => patch({ extended_address: event.target.value })}
                    />
                    <div className="contact-form-grid">
                      <ContactField
                        label={t("contacts.city")}
                        value={value.city}
                        maxLength={1024}
                        onChange={(event) => patch({ city: event.target.value })}
                      />
                      <ContactField
                        label={t("contacts.region")}
                        value={value.region}
                        maxLength={1024}
                        onChange={(event) => patch({ region: event.target.value })}
                      />
                      <ContactField
                        label={t("contacts.postalCode")}
                        value={value.postal_code}
                        maxLength={1024}
                        onChange={(event) => patch({ postal_code: event.target.value })}
                      />
                      <ContactField
                        label={t("contacts.country")}
                        value={value.country_code}
                        maxLength={2}
                        onChange={(event) =>
                          patch({ country_code: event.target.value.toUpperCase() })
                        }
                      />
                    </div>
                    {value.formatted_address && (
                      <ContactField
                        label={t("contacts.formattedAddress")}
                        value={value.formatted_address}
                        maxLength={1024}
                        onChange={(event) => patch({ formatted_address: event.target.value })}
                      />
                    )}
                  </>
                )}
              </ValueList>
              <ValueList
                title={t("contacts.links")}
                addLabel={t("contacts.addLink")}
                values={draft.links}
                onChange={(values) => set("links", values)}
                onAdd={() => set("links", [...draft.links, { ...common(), url: "" }])}
              >
                {(value, patch) => (
                  <ContactField
                    label={t("contacts.website")}
                    type="url"
                    value={value.url}
                    maxLength={2048}
                    onChange={(event) => patch({ url: event.target.value })}
                  />
                )}
              </ValueList>
              <section className="contact-editor-section">
                <h3>{t("contacts.personal")}</h3>
                <div className="contact-form-grid">
                  <ContactField
                    label={t("contacts.nickname")}
                    value={draft.nickname}
                    maxLength={255}
                    onChange={(event) => set("nickname", event.target.value)}
                  />
                  <ContactField
                    label={t("contacts.birthday")}
                    type="date"
                    value={draft.birthday}
                    onChange={(event) => set("birthday", event.target.value)}
                  />
                </div>
                <ContactField label={t("contacts.notes")}>
                  <Textarea
                    rows={4}
                    value={draft.notes}
                    maxLength={10000}
                    onChange={(event) => set("notes", event.target.value)}
                  />
                </ContactField>
              </section>
              {!!definitions.filter(
                (definition) =>
                  !definition.archived_at || Object.hasOwn(draft.custom_fields, definition.id),
              ).length && (
                <section className="contact-editor-section">
                  <h3>{t("contacts.customFields")}</h3>
                  {definitions
                    .filter(
                      (definition) =>
                        !definition.archived_at ||
                        Object.hasOwn(draft.custom_fields, definition.id),
                    )
                    .map((definition) => (
                      <CustomInput
                        key={definition.id}
                        definition={definition}
                        value={draft.custom_fields[definition.id]}
                        onChange={(value) =>
                          set("custom_fields", { ...draft.custom_fields, [definition.id]: value })
                        }
                      />
                    ))}
                </section>
              )}
            </fieldset>
          </div>
          <ContactNotice error={action.error} />
          <footer>
            <Button variant="ghost" disabled={action.busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={action.busy}>
              {t(action.busy ? "contacts.saving" : "common.save")}
            </Button>
          </footer>
        </form>
      </ContactModal>
      {discard && (
        <Confirm
          open
          title={t("contacts.discard")}
          description={t("contacts.discardDescription")}
          label={t("contacts.discard")}
          onClose={() => setDiscard(false)}
          onConfirm={async () => onClose()}
        />
      )}
    </>
  );
}

export function ContactFolderDialog({
  folder,
  parent = null,
  folders,
  onClose,
  onSaved,
}: {
  folder?: ContactFolder;
  parent?: string | null;
  folders: ContactFolder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(folder?.name ?? ""),
    [parentId, setParent] = useState(folder?.parent_id ?? parent),
    action = useContactAction(),
    operation = useRef(new MailOperation());
  const save = () =>
    action.run(async () => {
      const body = {
        name: name.trim(),
        parent_id: parentId,
        ...(folder ? { version: folder.version } : {}),
      };
      try {
        await api(folder ? `/api/contacts/folders/${folder.id}` : "/api/contacts/folders", {
          method: folder ? "PATCH" : "POST",
          body,
          headers: operation.current.headers(body),
        });
        operation.current.complete();
        onSaved();
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
        throw failure;
      }
    });
  return (
    <ContactModal
      title={t(folder ? "contacts.editFolder" : "contacts.newFolder")}
      busy={action.busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }}
      >
        <fieldset className="contact-dialog-body" disabled={action.busy}>
          <ContactField
            autoFocus
            required
            maxLength={255}
            label={t("contacts.folderName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <ContactField label={t("contacts.parentFolder")}>
            <SelectControl
              aria-label={t("contacts.parentFolder")}
              options={folderOptions(folders, folder?.id)}
              value={parentId ?? "root"}
              onValueChange={(value) => setParent(value === "root" ? null : value)}
            />
          </ContactField>
          <ContactNotice error={action.error} />
        </fieldset>
        <footer>
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={action.busy || !name.trim()}>
            {t("common.save")}
          </Button>
        </footer>
      </form>
    </ContactModal>
  );
}
