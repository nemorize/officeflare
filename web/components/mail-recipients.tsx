import { t } from "../../shared/i18n/index.ts";
import { useId } from "react";
import type { ReactNode } from "react";
import { parseRecipients } from "../lib/mail";
import { Chip, Button, Icon, Input, Field } from "./ui";
export function RecipientField({
  label,
  value,
  onChange,
  action,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  action?: ReactNode;
}) {
  const id = useId(),
    parts = value.split(/[,;\n]/),
    pending = parts.pop() ?? "",
    chips = parts.map((token) => token.trim()).filter(Boolean);
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
          </Chip>
        ))}
        <Input
          variant="integrated"
          id={id}
          value={pending.trimStart()}
          inputMode="email"
          autoComplete="off"
          placeholder={chips.length ? "" : t("componentsMailRecipients.addRecipients")}
          onChange={(event) => onChange([...chips, event.target.value].join(", "))}
          onBlur={() => {
            if (valid(pending)) commit();
          }}
          onKeyDown={(event) => {
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
