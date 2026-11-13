import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import { api, ApiError, errorMessage } from "../lib/api";
import { MailOperation } from "../lib/mail-helpers";
import type { ContactFolder } from "../lib/contacts";
import { useAccess } from "./console-access";
import { WorkspaceIconButton } from "./workspace-controls";
import { Button, Dialog, DialogPopup, Field, Input, SelectControl, useNotifications } from "./ui";

export function ContactSaveButton({
  emailAddress,
  displayName = "",
}: {
  emailAddress: string;
  displayName?: string;
}) {
  const { permissions } = useAccess();
  if (!emailAddress || !permissions.includes("contacts.entries.create")) return null;
  return <ContactSave emailAddress={emailAddress} displayName={displayName} />;
}
function ContactSave({ emailAddress, displayName }: { emailAddress: string; displayName: string }) {
  const id = useId(),
    notify = useNotifications(),
    operation = useRef(new MailOperation()),
    running = useRef(false);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(displayName),
    [email, setEmail] = useState(emailAddress),
    [folder, setFolder] = useState("root"),
    [folders, setFolders] = useState<ContactFolder[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [duplicate, setDuplicate] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ folders: ContactFolder[] }>("/api/contacts/folders", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setFolders(result.folders);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [open]);
  const save = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const body = {
      display_name: name.trim() || email.trim(),
      emails: [{ email_address: email.trim() }],
      folder_id: folder === "root" ? null : folder,
    };
    try {
      if (!duplicate) {
        const existing = await api<{ contacts: { id: string }[] }>(
          `/api/contacts/lookup?email_address=${encodeURIComponent(email.trim())}`,
        );
        if (existing.contacts.length) {
          setDuplicate(true);
          return;
        }
      }
      await api("/api/contacts", {
        method: "POST",
        body,
        headers: operation.current.headers(body),
      });
      operation.current.complete();
      setOpen(false);
      notify.success(t("contacts.saved"));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) operation.current.complete();
      setError(errorMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const folderName = (value: ContactFolder): string => {
    const parent = folders.find((item) => item.id === value.parent_id);
    return parent ? `${folderName(parent)} / ${value.name}` : value.name;
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <Dialog.Trigger
        render={<Button variant="ghost" size="sm" />}
        onClick={() => {
          setName(displayName);
          setEmail(emailAddress);
          setFolder("root");
          setError("");
          setDuplicate(false);
        }}
      >
        {t("contacts.save")}
      </Dialog.Trigger>
      <DialogPopup
        className="contact-save-dialog"
        data-ui-theme="neutral"
        viewportProps={{ className: "contacts-dialog-viewport" }}
      >
        <header className="contact-save-heading">
          <Dialog.Title>{t("contacts.save")}</Dialog.Title>
          <WorkspaceIconButton
            icon="close"
            label={t("common.close")}
            disabled={busy}
            onClick={() => setOpen(false)}
          />
        </header>
        <Dialog.Description className="visually-hidden">
          {t("contacts.personalDescription")}
        </Dialog.Description>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }}
        >
          <Field.Root>
            <Field.Label htmlFor={`${id}-name`}>{t("contacts.name")}</Field.Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={255}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label htmlFor={`${id}-email`}>{t("contacts.email")}</Field.Label>
            <Input
              id={`${id}-email`}
              value={email}
              type="email"
              required
              maxLength={254}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.target.value);
                setDuplicate(false);
              }}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label htmlFor={`${id}-folder`}>{t("contacts.folder")}</Field.Label>
            <SelectControl
              id={`${id}-folder`}
              value={folder}
              disabled={busy}
              onValueChange={setFolder}
              options={[
                { value: "root", label: t("contacts.root") },
                ...folders.map((item) => ({ value: item.id, label: folderName(item) })),
              ]}
            />
          </Field.Root>
          {duplicate && <p role="status">{t("contacts.alreadySaved")}</p>}
          {error && <p role="alert">{error}</p>}
          <div className="contact-save-actions">
            <Dialog.Close render={<Button variant="ghost" disabled={busy} />}>
              {t("common.cancel")}
            </Dialog.Close>
            <Button variant="primary" type="submit" disabled={busy}>
              {duplicate ? t("contacts.createAnyway") : t("contacts.save")}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog.Root>
  );
}
