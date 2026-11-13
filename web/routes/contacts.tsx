import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { t, plural } from "../../shared/i18n/index.ts";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/regional";
import {
  contactInitials,
  contactLocation,
  type ContactPage,
  type ContactRecord,
  type ContactSummary,
} from "../lib/contact-model";
import { useContacts } from "../components/contacts-context";
import {
  ContactIconButton,
  ContactNotice,
  useContactAction,
  useContactResource,
} from "../components/contacts-controls";
import { Confirm } from "../components/console-shared";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { Button, Icon, Menu, MenuPopup, useNotifications } from "../components/ui";

export function ContactsPage() {
  const contacts = useContacts(),
    location = useLocation(),
    [params, setParams] = useSearchParams(),
    view = contactLocation(location.pathname),
    notify = useNotifications(),
    action = useContactAction();
  const selected = params.get("contact"),
    query = params.get("q") ?? "",
    position = params.get("cursor"),
    previous = useRef<(string | null)[]>([]);
  const options = new URLSearchParams({
    limit: "50",
    ...(query ? { q: query } : {}),
    ...(view.trash ? { trashed: "true" } : {}),
    ...(view.folder ? { folder_id: view.folder } : view.unfiled ? { folder_id: "root" } : {}),
    ...(position ? { cursor: position } : {}),
  });
  const resource = useContactResource<ContactPage>(`/api/contacts?${options}`, contacts.revision),
    detail = useContactResource<{ contact: ContactRecord }>(
      selected
        ? `/api/contacts/${encodeURIComponent(selected)}${view.trash ? "?trashed=true" : ""}`
        : null,
      contacts.revision,
    );
  const [confirm, setConfirm] = useState<{
    mode: "trash" | "delete";
    record: ContactRecord;
  } | null>(null);
  useEffect(() => {
    previous.current = [];
  }, [location.pathname, query]);
  const choose = (id: string | null, replace = false) => {
    const next = new URLSearchParams(params);
    if (id) next.set("contact", id);
    else next.delete("contact");
    setParams(next, { replace });
  };
  const paginate = (cursor: string | null) => {
    const next = new URLSearchParams(params);
    next.delete("contact");
    if (cursor) next.set("cursor", cursor);
    else next.delete("cursor");
    setParams(next);
  };
  const restore = (record: ContactRecord) =>
    action.run(async () => {
      await api(`/api/contacts/${record.id}/restore`, {
        method: "POST",
        body: { version: record.version },
      });
      choose(null, true);
      contacts.refresh();
      notify.success(t("contacts.restored"));
    });
  const title = view.trash
    ? t("contacts.trash")
    : view.unfiled
      ? t("contacts.unfiled")
      : view.folder
        ? (contacts.folders.find((item) => item.id === view.folder)?.name ?? t("contacts.folder"))
        : t("contacts.all");
  const list = resource.data?.contacts ?? [];
  return (
    <div className={`contacts-page${selected ? " has-selection" : ""}`}>
      <section className="contacts-list-pane" aria-label={t("contacts.title")}>
        <div className="contacts-list-heading">
          <div>
            <h1>{title}</h1>
            {resource.data && <span>{plural("contacts.showing", list.length)}</span>}
          </div>
          <div className="contacts-list-actions">
            {view.folder && contacts.can("folders.manage") && (
              <ContactIconButton
                icon="edit"
                label={t("contacts.editFolder")}
                disabled={
                  contacts.loading || !contacts.folders.some((item) => item.id === view.folder)
                }
                onClick={() =>
                  contacts.editFolder(contacts.folders.find((item) => item.id === view.folder))
                }
              />
            )}
            <ContactIconButton
              icon="refresh"
              label={t("contacts.refresh")}
              disabled={resource.loading || contacts.loading}
              onClick={contacts.refresh}
            />
          </div>
        </div>
        <ContactNotice error={resource.error} retry={contacts.refresh} />
        <ContactNotice error={contacts.error} retry={contacts.refresh} />
        {resource.loading && !resource.data ? (
          <LoadingSkeleton kind="list" rows={7} />
        ) : !resource.error && !list.length ? (
          <div className="contacts-empty">
            <Icon name={view.trash ? "trash" : "users"} width={36} height={36} />
            <h2>
              {t(
                view.trash
                  ? "contacts.emptyTrash"
                  : query || view.folder || view.unfiled
                    ? "contacts.emptySearch"
                    : "contacts.emptyTitle",
              )}
            </h2>
            <p>
              {t(
                view.trash
                  ? "contacts.emptyTrashDescription"
                  : query || view.folder || view.unfiled
                    ? "contacts.emptySearchDescription"
                    : "contacts.emptyDescription",
              )}
            </p>
            {!view.trash && contacts.can("entries.create") && (
              <Button
                variant="primary"
                disabled={contacts.loading || !!contacts.error}
                onClick={() => contacts.edit()}
              >
                <Icon name="plus" />
                {t("contacts.newContact")}
              </Button>
            )}
          </div>
        ) : (
          !!list.length && (
            <div className="contacts-table-scroll">
              <table className="contacts-table">
                <thead>
                  <tr>
                    <th>{t("contacts.name")}</th>
                    <th>{t("contacts.email")}</th>
                    <th className="contact-phone-column">{t("contacts.phone")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((record) => (
                    <tr
                      key={record.id}
                      data-selected={selected === record.id || undefined}
                      onClick={() => choose(record.id)}
                    >
                      <td>
                        <Button
                          variant="plain"
                          className="contact-list-name"
                          aria-pressed={selected === record.id}
                        >
                          <span className="contact-avatar" aria-hidden="true">
                            {contactInitials(record.display_name)}
                          </span>
                          <span>
                            <strong>{record.display_name}</strong>
                            <small>
                              {[record.job_title, record.organization]
                                .filter(Boolean)
                                .join(" · ") ||
                                record.primary_email ||
                                record.primary_phone ||
                                ""}
                            </small>
                          </span>
                        </Button>
                      </td>
                      <td className="contact-email-column">{record.primary_email || "—"}</td>
                      <td className="contact-phone-column">{record.primary_phone || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {(!!position || !!resource.data?.next_cursor) && (
          <div className="contacts-pagination">
            <Button
              variant="ghost"
              size="sm"
              disabled={!position || resource.loading}
              onClick={() => paginate(previous.current.pop() ?? null)}
            >
              <Icon name="back" />
              {t("common.previous")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!resource.data?.next_cursor || resource.loading}
              onClick={() => {
                previous.current.push(position);
                paginate(resource.data!.next_cursor);
              }}
            >
              {t("common.next")}
              <Icon name="arrow" />
            </Button>
          </div>
        )}
      </section>
      {selected && (
        <aside className="contacts-detail-pane" aria-label={t("contacts.details")}>
          <>
            <div className="contacts-detail-toolbar">
              <h2>{t("contacts.details")}</h2>
              <ContactIconButton
                icon="close"
                label={t("contacts.backToList")}
                onClick={() => choose(null)}
              />
            </div>
            <div className="contacts-detail-actions">
              <div>
                {detail.data && !view.trash && contacts.can("entries.update") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={contacts.loading || !!contacts.error}
                    onClick={() => contacts.edit(detail.data!.contact)}
                  >
                    <Icon name="edit" />
                    {t("common.edit")}
                  </Button>
                )}
                {detail.data &&
                  (contacts.can("entries.delete") ||
                    (view.trash && contacts.can("entries.update"))) && (
                    <Menu.Root>
                      <Menu.Trigger
                        render={<Button variant="ghost" size="icon" />}
                        aria-label={t("contacts.more")}
                        disabled={action.busy}
                      >
                        <Icon name="more" />
                      </Menu.Trigger>
                      <MenuPopup>
                        {view.trash ? (
                          <>
                            {contacts.can("entries.update") && (
                              <Menu.Item onClick={() => void restore(detail.data!.contact)}>
                                {t("contacts.restore")}
                              </Menu.Item>
                            )}
                            {contacts.can("entries.delete") && (
                              <Menu.Item
                                data-variant="danger"
                                onClick={() =>
                                  setConfirm({ mode: "delete", record: detail.data!.contact })
                                }
                              >
                                {t("contacts.permanentDelete")}
                              </Menu.Item>
                            )}
                          </>
                        ) : (
                          contacts.can("entries.delete") && (
                            <Menu.Item
                              data-variant="danger"
                              onClick={() =>
                                setConfirm({ mode: "trash", record: detail.data!.contact })
                              }
                            >
                              {t("contacts.moveToTrash")}
                            </Menu.Item>
                          )
                        )}
                      </MenuPopup>
                    </Menu.Root>
                  )}
              </div>
            </div>
            <ContactNotice error={detail.error} retry={contacts.refresh} />
            <ContactNotice error={action.error} />
            {detail.loading && !detail.data ? (
              <LoadingSkeleton kind="reader" />
            ) : (
              detail.data && <ContactDetails record={detail.data.contact} />
            )}
            {view.trash && detail.data && contacts.can("entries.update") && (
              <div className="contacts-detail-restore">
                <Button
                  variant="primary"
                  disabled={action.busy}
                  onClick={() => void restore(detail.data!.contact)}
                >
                  <Icon name="undo" />
                  {t("contacts.restore")}
                </Button>
              </div>
            )}
          </>
        </aside>
      )}
      {confirm && (
        <Confirm
          open
          title={t(confirm.mode === "trash" ? "contacts.moveToTrash" : "contacts.permanentDelete")}
          description={t(
            confirm.mode === "trash"
              ? "contacts.trashDescription"
              : "contacts.permanentDescription",
            { name: confirm.record.display_name },
          )}
          label={t(confirm.mode === "trash" ? "contacts.moveToTrash" : "contacts.permanentDelete")}
          destructive
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api(
              `/api/contacts/${confirm.record.id}${confirm.mode === "delete" ? "/permanent" : ""}?version=${confirm.record.version}`,
              { method: "DELETE" },
            );
            choose(null, true);
            contacts.refresh();
            notify.success(t(confirm.mode === "trash" ? "contacts.trashed" : "contacts.deleted"));
          }}
        />
      )}
    </div>
  );
}
function ContactDetails({ record }: { record: ContactRecord }) {
  const contacts = useContacts(),
    notify = useNotifications();
  const group = (title: string, values: { label: string; value: ReactNode }[]) =>
    values.length ? (
      <section className="contact-detail-section">
        <h3>{title}</h3>
        <dl>
          {values.map((item, index) => (
            <div key={index}>
              {item.label && <dt>{item.label}</dt>}
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    ) : null;
  return (
    <div className="contact-details">
      <header className="contact-identity">
        <span className="contact-avatar contact-avatar-large" aria-hidden="true">
          {contactInitials(record.display_name)}
        </span>
        <h2>{record.display_name}</h2>
        {(record.job_title || record.organization) && (
          <p>{[record.job_title, record.organization].filter(Boolean).join(" · ")}</p>
        )}
        <span className="contact-folder-tag">
          <Icon name="folder" width={13} height={13} />
          {contacts.folders.find((folder) => folder.id === record.folder_id)?.name ??
            t("contacts.unfiled")}
        </span>
      </header>
      {group(
        t("contacts.emails"),
        record.emails.map((item) => ({
          label: [item.label, item.is_primary ? t("contacts.primary") : ""]
            .filter(Boolean)
            .join(" · "),
          value: (
            <div className="contact-detail-email">
              <a href={`mailto:${encodeURIComponent(item.email_address)}`}>{item.email_address}</a>
              <ContactIconButton
                icon="copy"
                label={t("contacts.copyEmail")}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(item.email_address);
                    notify.success(t("contacts.copied"));
                  } catch {
                    notify.info(t("contacts.copyManually"));
                  }
                }}
              />
            </div>
          ),
        })),
      )}
      {group(
        t("contacts.phones"),
        record.phones.map((item) => ({
          label: [item.label, item.is_primary ? t("contacts.primary") : ""]
            .filter(Boolean)
            .join(" · "),
          value: (
            <>
              <a href={`tel:${item.phone_number.replace(/[\s().-]/g, "")}`}>{item.phone_number}</a>
              {item.extension && (
                <small>
                  {t("contacts.extension")}: {item.extension}
                </small>
              )}
            </>
          ),
        })),
      )}
      {group(
        t("contacts.organization"),
        (
          [
            ["", record.organization],
            [t("contacts.department"), record.department],
            [t("contacts.jobTitle"), record.job_title],
          ] as [string, string][]
        )
          .filter(([, value]) => !!value)
          .map(([label, value]) => ({ label, value })),
      )}
      {group(
        t("contacts.addresses"),
        record.addresses.map((item) => ({
          label: item.label,
          value: (
            <span className="contact-multiline">
              {item.formatted_address ||
                [
                  item.street_address,
                  item.extended_address,
                  [item.city, item.region, item.postal_code].filter(Boolean).join(" "),
                  item.country_code,
                ]
                  .filter(Boolean)
                  .join("\n")}
            </span>
          ),
        })),
      )}
      {group(
        t("contacts.links"),
        record.links.map((item) => ({
          label: item.label,
          value: (
            <a
              href={/^https?:\/\//i.test(item.url) ? item.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.url}
              <Icon name="external" width={12} height={12} />
            </a>
          ),
        })),
      )}
      {group(
        t("contacts.personal"),
        (
          [
            [t("contacts.nickname"), record.nickname],
            [t("contacts.birthday"), record.birthday ?? ""],
          ] as [string, string][]
        )
          .filter(([, value]) => !!value)
          .map(([label, value]) => ({ label, value })),
      )}
      {record.custom_fields.length > 0 &&
        group(
          t("contacts.customFields"),
          record.custom_fields.map((item) => {
            const definition = contacts.fields.find((field) => field.id === item.field_id);
            return {
              label: `${definition?.label ?? t("contacts.customFields")}${definition?.archived_at ? ` · ${t("contacts.archived")}` : ""}`,
              value:
                typeof item.value === "boolean"
                  ? t(item.value ? "contacts.yes" : "contacts.no")
                  : Array.isArray(item.value)
                    ? item.value.join(", ")
                    : String(item.value ?? ""),
            };
          }),
        )}
      {record.notes && (
        <section className="contact-detail-section">
          <h3>{t("contacts.notes")}</h3>
          <p className="contact-multiline">{record.notes}</p>
        </section>
      )}
      <p className="contact-updated">
        {t("contacts.updated", {
          date: formatDateTime(record.updated_at, { dateStyle: "medium" }),
        })}
      </p>
    </div>
  );
}
