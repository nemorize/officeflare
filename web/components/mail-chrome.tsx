import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useMail, MailSidebar } from "./mail-context";
import { MailIconButton } from "./mail-controls";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { CheckboxLabel,
  Button,
  Drawer,
  DrawerPopup,
  SearchField,
  Icon,
  Input,
  Popover,
  PopoverPopup,
} from "./ui";
import {
  MailField,
  MailInput,
  MailSelect,
  MailForm,
  MailCheckbox,
  useMailMobile,
} from "./mail-common";
export function MailSettingsButton() {
  const mail = useMail();
  return (
    <MailIconButton
      icon="settings"
      label="Mail settings"
      nativeButton={false}
      render={
        <NavLink
          to={mail.href("/mail/settings")}
          onClick={() => mail.setMobileMenu(false)}
        />
      }
    />
  );
}

export function MailTopbar({ mobileAccount }: { mobileAccount: ReactNode }) {
  const mobile = useMailMobile();
  const mail = useMail(),
    navigate = useNavigate(),
    location = useLocation(),
    [params] = useSearchParams(),
    searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(params.get("q") ?? ""),
    [filters, setFilters] = useState(false),
    [filterText, setFilterText] = useState("");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [subject, setSubject] = useState(""),
    [after, setAfter] = useState(""),
    [before, setBefore] = useState(""),
    [unread, setUnread] = useState(false),
    [attached, setAttached] = useState(false);
  useEffect(() => setSearch(params.get("q") ?? ""), [params]);
  useEffect(() => {
    mail.setMobileMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !mail.preferences.shortcuts ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,[contenteditable='true'],[role='dialog'],[role='menu'],[role='listbox']",
          ))
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === "c") {
        event.preventDefault();
        mail.compose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mail.preferences.shortcuts, mail.compose]);
  const openFilters = (open: boolean) => {
    if (open) {
      const fields: Record<string, string> = {},
        remaining: string[] = [];
      let onlyUnread = false,
        hasAttachment = false;
      for (const token of search.match(/-?(?:[a-z]+:)?"[^"]*"|\S+/g) ?? []) {
        const match = /^(from|to|subject|after|before):(.+)$/.exec(token);
        if (match && !fields[match[1]!])
          fields[match[1]!] = match[2]!.replace(/^"|"$/g, "");
        else if (token === "is:unread") onlyUnread = true;
        else if (token === "has:attachment") hasAttachment = true;
        else remaining.push(token);
      }
      setFrom(fields.from ?? "");
      setTo(fields.to ?? "");
      setSubject(fields.subject ?? "");
      setAfter(fields.after ?? "");
      setBefore(fields.before ?? "");
      setUnread(onlyUnread);
      setAttached(hasAttachment);
      setFilterText(remaining.join(" "));
    }
    setFilters(open);
  };
  const submit = (advanced = false) => {
    const quoted = (field: string, value: string) =>
      value.trim() ? `${field}:"${value.trim().replaceAll('"', "")}"` : "";
    const query = advanced
      ? [
          filterText,
          quoted("from", from),
          quoted("to", to),
          quoted("subject", subject),
          after && `after:${after}`,
          before && `before:${before}`,
          unread && "is:unread",
          attached && "has:attachment",
        ]
          .filter(Boolean)
          .join(" ")
      : search.trim();
    const next = new URLSearchParams();
    if (mail.box) next.set("mailbox", mail.box.id);
    if (query) next.set("q", query);
    navigate(`/mail?${next}`);
    setFilters(false);
  };
  const filterForm = (
    <MailForm
      className="mail-filter-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        submit(true);
      }}
    >
      {!mobile && <h2>Search filters</h2>}
      <div className="mail-filter-fields">
        <div className="mail-form-grid">
          <MailInput
            label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <MailInput
            label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <MailInput
            label="Subject"
            fieldClassName="mail-filter-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <MailInput
            label="After"
            type="date"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
          <MailInput
            label="Before"
            type="date"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
          />
        </div>
        <div className="mail-filter-checks">
          <CheckboxLabel>
            <MailCheckbox
              checked={unread}
              onCheckedChange={(v) => setUnread(!!v)}
            />
            Unread only
          </CheckboxLabel>
          <CheckboxLabel>
            <MailCheckbox
              checked={attached}
              onCheckedChange={(v) => setAttached(!!v)}
            />
            Has attachments
          </CheckboxLabel>
        </div>
      </div>
      <div className="mail-filter-footer">
        <Button variant="primary" type="submit">
          Search
        </Button>
      </div>
    </MailForm>
  );
  return (
    <header className="mail-topbar">
      <MailIconButton
        icon="menu"
        label="Toggle mail navigation"
        onClick={() => {
          if (window.matchMedia("(max-width: 760px)").matches)
            mail.setMobileMenu(true);
          else
            void mail.setPreferences({
              sidebar_collapsed: !mail.preferences.sidebar_collapsed,
            });
        }}
      />
      {mail.preferences.sidebar_collapsed && (
        <MailIconButton
          className="mail-topbar-compose"
          icon="plus"
          label="Compose"
          disabled={!mail.box?.access?.read || !mail.box?.access?.write}
          onClick={() => mail.compose()}
        />
      )}
      <SearchField
        className="mail-global-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Icon name="search" />
        <Input variant="integrated"
          ref={searchInput}
          aria-label="Search mail"
          placeholder="Search mail"
          value={search}
          maxLength={1000}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <MailIconButton
            icon="close"
            label="Clear search"
            onClick={() => {
              setSearch("");
              navigate(mail.href("/mail"));
            }}
          />
        )}
        {mobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search filters"
            aria-haspopup="dialog"
            onClick={() => openFilters(true)}
          >
            <Icon name="controls" />
          </Button>
        ) : (
          <Popover.Root open={filters} onOpenChange={openFilters}>
            <Popover.Trigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Search filters"
                />
              }
            >
              <Icon name="controls" />
            </Popover.Trigger>
            <PopoverPopup
              className="mail-filter-popup"
              positionerProps={{ side: "bottom", align: "end", sideOffset: 12 }}
            >
              {filterForm}
            </PopoverPopup>
          </Popover.Root>
        )}
      </SearchField>
      <Drawer.Provider>
        <Drawer.Root
          open={filters && mobile}
          onOpenChange={openFilters}
          swipeDirection="right"
        >
          <DrawerPopup side="right" padding="none"
            className="mail-search-drawer"
            viewportProps={{
              className: "mail-drawer-viewport mail-drawer-right",
            }}
          >
            <div className="mail-drawer-heading">
              <Drawer.Title>Search filters</Drawer.Title>
              <MailIconButton
                icon="close"
                label="Close search filters"
                onClick={() => openFilters(false)}
              />
            </div>
            <Drawer.Description className="mail-sr-only">
              Find messages in this mailbox.
            </Drawer.Description>
            {filterForm}
          </DrawerPopup>
        </Drawer.Root>
        <WorkspaceNavigationDrawer open={mail.mobileMenu} onOpenChange={mail.setMobileMenu} title="Mail" account={mobileAccount} actions={<MailSettingsButton />}><MailSidebar /></WorkspaceNavigationDrawer>
      </Drawer.Provider>
    </header>
  );
}

export function MailPreferenceFields() {
  const mail = useMail();
  return (
    <div className="mail-preference-fields">
      <MailField label="Display density">
        <MailSelect
          value={mail.preferences.density}
          onValueChange={(density) => {
            void mail.setPreferences({
              density: density as "comfortable" | "compact",
            });
          }}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </MailField>
      <MailField label="Reading pane">
        <MailSelect
          value={mail.preferences.reading_pane}
          onValueChange={(reading_pane) => {
            void mail.setPreferences({
              reading_pane: reading_pane as "none" | "right",
            });
          }}
          options={[
            { value: "none", label: "Full-width list" },
            { value: "right", label: "Right of inbox" },
          ]}
        />
      </MailField>
      <CheckboxLabel className="mail-preference-check">
        <MailCheckbox
          checked={mail.preferences.conversation_view}
          onCheckedChange={(conversation_view) => {
            void mail.setPreferences({
              conversation_view: !!conversation_view,
            });
          }}
        />
        <span>
          <strong>Conversation view</strong>
          <small>Group replies into one conversation.</small>
        </span>
      </CheckboxLabel>
      <CheckboxLabel className="mail-preference-check">
        <MailCheckbox
          checked={mail.preferences.shortcuts}
          onCheckedChange={(shortcuts) => {
            void mail.setPreferences({ shortcuts: !!shortcuts });
          }}
        />
        <span>
          <strong>Keyboard shortcuts</strong>
          <small>c Compose · / Search · j/k Move · e Archive · r Reply</small>
        </span>
      </CheckboxLabel>
      <MailField label="Undo send">
        <MailSelect
          value={String(mail.preferences.undo_seconds)}
          onValueChange={(value) => {
            void mail.setPreferences({ undo_seconds: Number(value) });
          }}
          options={[0, 5, 10, 20, 30].map((value) => ({
            value: String(value),
            label: value ? `${value} seconds` : "Off",
          }))}
        />
      </MailField>
      <p className="mail-hint">
        Your preferences apply only to your account. Folder and mailbox settings
        are shared.
      </p>
    </div>
  );
}
