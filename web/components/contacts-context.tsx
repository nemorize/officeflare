import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import {
  contactLocation,
  type ContactFolder,
  type ContactRecord,
  type ContactFieldDefinition,
} from "../lib/contact-model";
import { useAccess } from "./console-access";
import { useContactResource } from "./contacts-controls";
import { ContactEditor, ContactFolderDialog } from "./contact-editor";
import { useNotifications } from "./ui";
import "../routes/contacts.css";

interface ContactsContextValue {
  folders: ContactFolder[];
  fields: ContactFieldDefinition[];
  loading: boolean;
  error: string;
  revision: number;
  can: (
    permission:
      "entries.create" | "entries.update" | "entries.delete" | "folders.manage" | "fields.manage",
  ) => boolean;
  refresh: () => void;
  edit: (contact?: ContactRecord) => void;
  editFolder: (folder?: ContactFolder, parent?: string | null) => void;
}
const ContactsContext = createContext<ContactsContextValue | null>(null);
export const useContacts = () => useContext(ContactsContext)!;
export function ContactsProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    navigate = useNavigate(),
    access = useAccess(),
    notify = useNotifications();
  const [revision, setRevision] = useState(0),
    [editor, setEditor] = useState<{ contact?: ContactRecord; folder: string | null } | null>(null),
    [folderEditor, setFolderEditor] = useState<{
      folder?: ContactFolder;
      parent: string | null;
    } | null>(null);
  const active =
    location.pathname.startsWith("/contacts") && access.permissions.includes("contacts.access");
  const folders = useContactResource<{ folders: ContactFolder[] }>(
      active ? "/api/contacts/folders" : null,
      revision,
    ),
    definitions = useContactResource<{ fields: ContactFieldDefinition[] }>(
      active ? "/api/contacts/field-definitions?include_archived=true" : null,
      revision,
    );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const can: ContactsContextValue["can"] = (permission) =>
    access.permissions.includes(`contacts.${permission}`);
  return (
    <ContactsContext
      value={{
        folders: folders.data?.folders ?? [],
        fields: definitions.data?.fields ?? [],
        loading: folders.loading || definitions.loading,
        error: folders.error || definitions.error,
        revision,
        can,
        refresh,
        edit: (contact) =>
          setEditor({ contact, folder: contactLocation(location.pathname).folder }),
        editFolder: (folder, parent = null) => setFolderEditor({ folder, parent }),
      }}
    >
      {children}
      {editor && can(editor.contact ? "entries.update" : "entries.create") && (
        <ContactEditor
          key={editor.contact?.id ?? "new"}
          contact={editor.contact}
          folder={editor.folder}
          folders={folders.data?.folders ?? []}
          definitions={definitions.data?.fields ?? []}
          onClose={() => setEditor(null)}
          onSaved={(contact) => {
            setEditor(null);
            refresh();
            notify.success(t("contacts.saved"));
            navigate(
              `${contact.folder_id ? `/contacts/folders/${contact.folder_id}` : "/contacts"}?contact=${contact.id}`,
            );
          }}
        />
      )}
      {folderEditor && can("folders.manage") && (
        <ContactFolderDialog
          key={folderEditor.folder?.id ?? "new"}
          folder={folderEditor.folder}
          parent={folderEditor.parent}
          folders={folders.data?.folders ?? []}
          onClose={() => setFolderEditor(null)}
          onSaved={() => {
            setFolderEditor(null);
            refresh();
            notify.success(t("contacts.folderSaved"));
          }}
        />
      )}
    </ContactsContext>
  );
}
