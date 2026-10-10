import { useId } from "react";
import type { ReactNode } from "react";
import { parseRecipients } from "../lib/mail";
import { Button, Icon, Input, Field } from "./ui";
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
    <Field.Root className="mail-recipient-field">
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <div className="mail-recipient-controls">
        {chips.map((chip, index) => (
          <span
            key={`${chip}:${index}`}
            className={`mail-recipient-chip${valid(chip) ? "" : " is-invalid"}`}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Edit ${chip}`}
              onClick={() =>
                onChange(
                  [...chips.filter((_, i) => i !== index), chip].join(", "),
                )
              }
            >
              {chip}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${chip}`}
              onClick={() =>
                onChange(
                  [...chips.filter((_, i) => i !== index), pending].join(", "),
                )
              }
            >
              <Icon name="close" width="12" height="12" />
            </Button>
          </span>
        ))}
        <Input
          id={id}
          value={pending.trimStart()}
          inputMode="email"
          autoComplete="off"
          placeholder={chips.length ? "" : "Add recipients"}
          onChange={(event) =>
            onChange([...chips, event.target.value].join(", "))
          }
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
              onChange(
                [...chips, pending + text.replaceAll(/[;\n]/g, ", ")].join(
                  ", ",
                ),
              );
            }
          }}
        />
      </div>
      {action}
      {chips.some((chip) => !valid(chip)) && (
        <Field.Description>
          Check the highlighted email addresses before sending.
        </Field.Description>
      )}
    </Field.Root>
  );
}
