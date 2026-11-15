import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import type { CollaborationClient } from "../lib/collaboration/client";
import { replaceSharedText } from "../lib/collaboration/text";
import { Button, Input, useNotifications } from "./ui";
import { WikiDialog } from "./wiki-controls";
import { WorkspaceNotice } from "./workspace-dialog";

export function WikiRenameDialog({
  client,
  onClose,
}: {
  client: CollaborationClient;
  onClose: () => void;
}) {
  const original = useRef(client.doc.getText("title").toString()),
    notify = useNotifications();
  const [name, setName] = useState(original.current),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!busy) return;
    const check = () => {
      if (client.status === "saved" && !client.unsaved) {
        setBusy(false);
        notify.success(t("wiki.renamed"));
        onClose();
      } else if (["offline", "error", "reset", "revoked", "readonly"].includes(client.status)) {
        setBusy(false);
        setError(t("wiki.syncError"));
      }
    };
    const unsubscribe = client.subscribe(check),
      timer = setTimeout(() => {
        setBusy(false);
        setError(t("wiki.syncError"));
      }, 15000);
    check();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [busy, client, notify, onClose]);
  const save = () => {
    if (busy || !name.trim() || !client.capabilities.write || client.status !== "saved") return;
    const field = client.doc.getText("title");
    if (field.toString() !== original.current) {
      original.current = field.toString();
      setError(t("wiki.renameChanged", { title: original.current || t("wiki.untitled") }));
      return;
    }
    setError("");
    setBusy(true);
    replaceSharedText(field, name.trim());
    original.current = name.trim();
  };
  return (
    <WikiDialog open title={t("wiki.rename")} onClose={onClose} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label>
          {t("common.name")}
          <Input
            autoFocus
            required
            maxLength={500}
            value={name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <WorkspaceNotice error={error} />
        <div className="wiki-dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy || !name.trim() || !client.capabilities.write || client.status !== "saved"
            }
          >
            {t(busy ? "common.saving" : "common.save")}
          </Button>
        </div>
      </form>
    </WikiDialog>
  );
}
