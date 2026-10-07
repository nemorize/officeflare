import { useState } from "react";
import { Button, Field, Input } from "./ui";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  describedBy?: string;
}

export function PasswordField({ id, label, value, onChange, autoComplete, describedBy }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <Field.Root name={id}>
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <br />
      <Input id={id} type={visible ? "text" : "password"} required
        autoComplete={autoComplete} value={value} onValueChange={onChange}
        aria-describedby={describedBy} />
      {" "}
      <Button type="button" aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        aria-pressed={visible} onClick={() => setVisible(!visible)}>
        {visible ? "Hide" : "Show"}
      </Button>
      <Field.Error />
    </Field.Root>
  );
}
