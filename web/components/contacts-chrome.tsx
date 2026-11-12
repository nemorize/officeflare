import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { api } from "../lib/api";
import { contactLocation, type ContactFolder } from "../lib/contact-model";
import { useContacts } from "./contacts-context";
import { ContactIconButton, ContactNotice } from "./contacts-controls";
import { WorkspaceMenuButton, WorkspaceNavigationDrawer } from "./workspace-navigation";
import { Confirm } from "./console-shared";
import { LoadingSkeleton } from "./loading-skeleton";
import { Button, Icon, Input, Menu, MenuPopup, SearchField, useNotifications } from "./ui";

export function ContactsSettingsButton({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ContactIconButton
      icon="settings"
      label={t("contacts.customFields")}
      nativeButton={false}
      render={<NavLink to="/contacts/fields" onClick={onNavigate} />}
    />
  );
}
export function ContactsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const contacts = useContacts(),
    location = useLocation(),
    navigate = useNavigate(),
    notify = useNotifications();
  const [collapsed, setCollapsed] = useState(new Set<string>()),
    [removing, setRemoving] = useState<ContactFolder | null>(null);
  const renderFolders = (parent: string | null, ancestors: string[] = []): ReactNode => (
    <ul>
      {contacts.folders
        .filter((folder) => folder.parent_id === parent && !ancestors.includes(folder.id))
        .map((folder) => {
          const nested = contacts.folders.some((item) => item.parent_id === folder.id),
            expanded = !collapsed.has(folder.id);
          return (
            <li key={folder.id}>
              <div className="contact-folder-row">
                {nested ? (
                  <ContactIconButton
                    className="contact-folder-toggle"
                    icon={expanded ? "down" : "chevron"}
                    label={t(expanded ? "contacts.collapseFolder" : "contacts.expandFolder", {
                      name: folder.name,
                    })}
                    aria-expanded={expanded}
                    onClick={() =>
                      setCollapsed((old) => {
                        const next = new Set(old);
                        if (expanded) next.add(folder.id);
                        else next.delete(folder.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <span className="contact-folder-spacer" />
                )}
                <NavLink to={`/contacts/folders/${folder.id}`} onClick={onNavigate}>
                  <Icon name="folder" />
                  <span>{folder.name}</span>
                </NavLink>
                {contacts.can("folders.manage") && (
                  <Menu.Root>
                    <Menu.Trigger
                      render={
                        <Button variant="ghost" size="icon" className="contact-folder-menu" />
                      }
                      aria-label={t("contacts.folderActions", { name: folder.name })}
                    >
                      <Icon name="more" />
                    </Menu.Trigger>
                    <MenuPopup>
                      <Menu.Item onClick={() => contacts.editFolder(undefined, folder.id)}>
                        {t("contacts.newFolder")}
                      </Menu.Item>
                      <Menu.Item onClick={() => contacts.editFolder(folder)}>
                        {t("contacts.editFolder")}
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item data-variant="danger" onClick={() => setRemoving(folder)}>
                        {t("contacts.deleteFolder")}
                      </Menu.Item>
                    </MenuPopup>
                  </Menu.Root>
                )}
              </div>
              {nested && expanded && renderFolders(folder.id, [...ancestors, folder.id])}
            </li>
          );
        })}
    </ul>
  );
  return (
    <div className="contacts-sidebar-body">
      <div className="workspace-create-action">
        <Button
          className="workspace-create-button"
          variant="primary"
          size="lg"
          disabled={!contacts.can("entries.create") || contacts.loading || !!contacts.error}
          onClick={() => {
            contacts.edit();
            onNavigate?.();
          }}
        >
          <Icon name="plus" />
          {t("contacts.newContact")}
        </Button>
      </div>
      <nav className="workspace-nav contacts-nav" aria-label={t("contacts.title")}>
        <NavLink end to="/contacts" onClick={onNavigate}>
          <Icon name="users" />
          <span>{t("contacts.all")}</span>
        </NavLink>
        <NavLink to="/contacts/unfiled" onClick={onNavigate}>
          <Icon name="inbox" />
          <span>{t("contacts.unfiled")}</span>
        </NavLink>
        <NavLink to="/contacts/trash" onClick={onNavigate}>
          <Icon name="trash" />
          <span>{t("contacts.trash")}</span>
        </NavLink>
      </nav>
      <div className="contact-folder-heading">
        <h2>{t("contacts.folders")}</h2>
        {contacts.can("folders.manage") && (
          <ContactIconButton
            icon="plus"
            label={t("contacts.newFolder")}
            disabled={contacts.loading || !!contacts.error}
            onClick={() => contacts.editFolder()}
          />
        )}
      </div>
      {contacts.loading && !contacts.folders.length ? (
        <LoadingSkeleton rows={2} />
      ) : contacts.folders.length ? (
        <nav className="contact-folder-tree" aria-label={t("contacts.folders")}>
          {renderFolders(null)}
        </nav>
      ) : (
        <p className="contacts-sidebar-empty">{t("contacts.noFolders")}</p>
      )}
      <ContactNotice error={contacts.error} retry={contacts.refresh} />
      <nav className="workspace-nav contacts-sidebar-footer">
        <NavLink to="/contacts/fields" onClick={onNavigate}>
          <Icon name="controls" />
          <span>{t("contacts.customFields")}</span>
        </NavLink>
      </nav>
      {removing && (
        <Confirm
          open
          title={t("contacts.deleteFolder")}
          description={t("contacts.deleteFolderDescription", { name: removing.name })}
          label={t("common.delete")}
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/api/contacts/folders/${removing.id}?version=${removing.version}`, {
              method: "DELETE",
            });
            if (location.pathname === `/contacts/folders/${removing.id}`)
              navigate(
                removing.parent_id ? `/contacts/folders/${removing.parent_id}` : "/contacts",
              );
            contacts.refresh();
            notify.success(t("contacts.folderDeleted"));
          }}
        />
      )}
    </div>
  );
}
export function ContactsTopbar({ mobileAccount }: { mobileAccount: ReactNode }) {
  const contacts = useContacts(),
    location = useLocation(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [menu, setMenu] = useState(false);
  useEffect(() => setQuery(params.get("q") ?? ""), [params]);
  useEffect(() => setMenu(false), [location.pathname]);
  return (
    <>
      <header className="workspace-topbar contacts-topbar">
        <WorkspaceMenuButton label={t("contacts.openNavigation")} onClick={() => setMenu(true)} />
        <SearchField
          className="contacts-search"
          onSubmit={(event) => {
            event.preventDefault();
            const next = new URLSearchParams();
            if (query.trim()) next.set("q", query.trim());
            navigate(
              `${location.pathname === "/contacts/fields" ? "/contacts" : location.pathname}?${next}`,
            );
          }}
        >
          <Icon name="search" />
          <Input
            variant="integrated"
            type="search"
            aria-label={t("contacts.search")}
            placeholder={t("contacts.search")}
            value={query}
            maxLength={255}
            onChange={(event) => setQuery(event.target.value)}
          />
        </SearchField>
        <div className="contacts-topbar-actions">
          <ContactIconButton
            icon="refresh"
            label={t("contacts.refresh")}
            disabled={contacts.loading}
            onClick={contacts.refresh}
          />
          <Button
            className="contacts-mobile-new"
            variant="primary"
            size="icon"
            aria-label={t("contacts.newContact")}
            disabled={!contacts.can("entries.create") || contacts.loading || !!contacts.error}
            onClick={() => contacts.edit()}
          >
            <Icon name="plus" />
          </Button>
        </div>
      </header>
      <WorkspaceNavigationDrawer
        open={menu}
        onOpenChange={setMenu}
        title={t("contacts.title")}
        account={mobileAccount}
        actions={<ContactsSettingsButton onNavigate={() => setMenu(false)} />}
      >
        <ContactsSidebar onNavigate={() => setMenu(false)} />
      </WorkspaceNavigationDrawer>
    </>
  );
}
