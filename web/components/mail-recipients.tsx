import { t } from "../../shared/i18n/index.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseRecipients } from "../lib/mail";
import { Chip, Button, Icon, Input, Field, Autocomplete, AutocompletePopup } from "./ui";
import { contactSuggestions, type ContactSuggestion } from "../lib/contacts";
import { useAccess } from "./console-access";
import { ContactSaveButton } from "./contact-save";
import { useSession } from "../lib/session";
export function RecipientField({
  label,
  value,
  onChange,
  action,
  onContactSelect,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  action?: ReactNode;
  onContactSelect?: (contact: ContactSuggestion) => void;
}) {
  const id = useId(),
    parts = value.split(/[,;\n]/),
    pending = parts.pop() ?? "",
    chips = parts.map((token) => token.trim()).filter(Boolean);
  const canSearch = useAccess().permissions.includes("contacts.access"),
    query = pending.trim();
  const sessionId = useSession().session?.tokens.session_id;
  const [matches, setMatches] = useState<{
      query: string;
      sessionId?: string;
      items: ContactSuggestion[];
    }>({
      query: "",
      items: [],
    }),
    [open, setOpen] = useState(false);
  const highlighted = useRef<ContactSuggestion | undefined>(undefined);
  const suggestions =
    canSearch && matches.query === query && matches.sessionId === sessionId
      ? matches.items.filter(
          (item) => !chips.some((chip) => chip.toLowerCase() === item.email_address.toLowerCase()),
        )
      : [];
  useEffect(() => {
    highlighted.current = undefined;
    if (!canSearch || !query) return;
    const controller = new AbortController(),
      timer = window.setTimeout(() => {
        void contactSuggestions(query, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted)
              setMatches({ query, sessionId, items: result.suggestions });
          })
          .catch(() => {
            if (!controller.signal.aborted) setMatches({ query, sessionId, items: [] });
          });
      }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, canSearch, sessionId]);
  const valid = (text: string) => {
    try {
      return parseRecipients(text).length === 1;
    } catch {
      return false;
    }
  };
  const commit = () => {
    if (pending.trim()) onChange([...chips, pending.trim(), ""].join(", "));
  };
  return (
    <Field.Root className="mail-recipient-field" invalid={chips.some((chip) => !valid(chip))}>
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <div className="mail-recipient-controls">
        {chips.map((chip, index) => (
          <Chip key={`${chip}:${index}`} invalid={!valid(chip)}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("componentsMailRecipients.edit", {
                chip: chip,
                value2: valid(chip) ? "" : t("componentsMailRecipients.invalidEmailAddress"),
              })}
              onClick={() => onChange([...chips.filter((_, i) => i !== index), chip].join(", "))}
            >
              {!valid(chip) && <Icon name="info" width="12" height="12" />} {chip}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("componentsMailRecipients.remove", { chip: chip })}
              onClick={() => onChange([...chips.filter((_, i) => i !== index), pending].join(", "))}
            >
              <Icon name="close" width="12" height="12" />
            </Button>
            {valid(chip) && <ContactSaveButton emailAddress={chip} />}
          </Chip>
        ))}
        <Autocomplete.Root
          items={suggestions}
          filteredItems={suggestions}
          itemToStringValue={(item) => item.email_address}
          value={pending.trimStart()}
          open={open && suggestions.length > 0}
          onOpenChange={setOpen}
          onItemHighlighted={(item) => {
            highlighted.current = item;
          }}
          onValueChange={(next, details) => {
            if (details.reason === "item-press") {
              const contact = suggestions.find((item) => item.email_address === next);
              if (contact) onContactSelect?.(contact);
              onChange([...chips, next, ""].join(", "));
              setOpen(false);
            } else {
              onChange([...chips, next].join(", "));
              setOpen(true);
            }
          }}
        >
          <Autocomplete.InputGroup className="mail-recipient-input">
            <Autocomplete.Input
              render={<Input variant="integrated" />}
              id={id}
              inputMode="email"
              autoComplete="off"
              placeholder={chips.length ? "" : t("componentsMailRecipients.addRecipients")}
              onBlur={() => {
                if (valid(pending)) commit();
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && open && highlighted.current) return;
                if (["Enter", "Tab"].includes(event.key) && pending.trim()) {
                  if (event.key === "Enter") event.preventDefault();
                  commit();
                }
                if (event.key === "Backspace" && !pending && chips.length) {
                  event.preventDefault();
                  onChange(chips.join(", "));
                }
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text/plain");
                if (/[;\n]/.test(text)) {
                  event.preventDefault();
                  onChange([...chips, pending + text.replaceAll(/[;\n]/g, ", ")].join(", "));
                }
              }}
            />
          </Autocomplete.InputGroup>
          <AutocompletePopup>
            <Autocomplete.List aria-label={t("contacts.suggestions")}>
              {(item: ContactSuggestion) => (
                <Autocomplete.Item key={item.email_id} value={item}>
                  <span>{item.display_name}</span>{" "}
                  <small>
                    {item.email_address}
                    {item.label ? ` · ${item.label}` : ""}
                  </small>
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </AutocompletePopup>
        </Autocomplete.Root>
      </div>
      {action}
      {chips.some((chip) => !valid(chip)) && (
        <Field.Description>
          {t("componentsMailRecipients.invalidAddressesEditOrRemoveThemBeforeSending", {
            join: chips.filter((chip) => !valid(chip)).join(", "),
          })}
        </Field.Description>
      )}
    </Field.Root>
  );
}
