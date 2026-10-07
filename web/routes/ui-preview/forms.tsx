import { useRef, useState } from "react";
import { Autocomplete, AutocompletePopup, Button, Checkbox, CheckboxGroup, Combobox, ComboboxPopup,
  Field, Fieldset, Form, Icon, Input, NumberField, OTPField, Radio, RadioGroup, Select, SelectPopup,
  Slider, Switch, TextField } from "@/components/ui";

const apps = ["Calendar", "Files", "Mail"];
const roles = ["Reader", "Editor", "Administrator"];

export function InputDemo() {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <label htmlFor="preview-input">Display name</label>{" "}
    <Input ref={input} id="preview-input" placeholder="Your name" />{" "}
    <Button onClick={() => input.current?.focus()}>Focus input</Button>
  </>;
}

export function FieldDemo() {
  return <Field.Root name="preview-field" validationMode="onBlur">
    <Field.Label>Contact email</Field.Label>{" "}
    <Input type="email" required />
    <Field.Description>Enter an email address, then move focus to validate.</Field.Description>
    <Field.Error />
  </Field.Root>;
}

export function FieldsetDemo() {
  return <Fieldset.Root>
    <Fieldset.Legend>Contact details</Fieldset.Legend>
    <TextField label="Given name" name="preview-given-name" />
    <TextField label="Family name" name="preview-family-name" />
  </Fieldset.Root>;
}

export function FormDemo() {
  const [result, setResult] = useState("");
  return <Form onFormSubmit={(values) => setResult(`Submitted: ${String(values["preview-form-email"] ?? "")}`)}>
    <TextField name="preview-form-email" label="Email for preview form" type="email" required
      description="Only local demo state is updated." />
    <Button type="submit" variant="primary">Submit preview form</Button>
    <p role="status">{result}</p>
  </Form>;
}

export function CheckboxDemo() {
  return <Field.Root name="preview-notifications">
    <Field.Label><Checkbox.Root>
      <Checkbox.Indicator aria-hidden="true">✓</Checkbox.Indicator>
    </Checkbox.Root>{" "}Enable notifications</Field.Label>
  </Field.Root>;
}

export function CheckboxGroupDemo() {
  const [value, setValue] = useState(["Mail"]);
  return <Fieldset.Root>
    <Fieldset.Legend>Enabled applications</Fieldset.Legend>
    <CheckboxGroup value={value} onValueChange={setValue} aria-label="Enabled applications">
      {apps.map((app) => <label key={app}>
        <Checkbox.Root value={app}><Checkbox.Indicator aria-hidden="true">✓</Checkbox.Indicator></Checkbox.Root>
        {" "}{app}{" "}
      </label>)}
    </CheckboxGroup>
    <p role="status">Selected: {value.join(", ") || "None"}</p>
  </Fieldset.Root>;
}

export function RadioGroupDemo() {
  const [value, setValue] = useState("Reader");
  return <Fieldset.Root>
    <Fieldset.Legend>Example role</Fieldset.Legend>
    <RadioGroup value={value} onValueChange={setValue} aria-label="Example role">
      {roles.map((role) => <label key={role}>
        <Radio.Root value={role}><Radio.Indicator aria-hidden="true">●</Radio.Indicator></Radio.Root>
        {" "}{role}{" "}
      </label>)}
    </RadioGroup>
    <p role="status">Role: {value}</p>
  </Fieldset.Root>;
}

export function SwitchDemo() {
  const [checked, setChecked] = useState(false);
  return <Field.Root name="preview-presence">
    <Field.Label><Switch.Root checked={checked} onCheckedChange={setChecked}>
      <Switch.Thumb />
    </Switch.Root>{" "}Show online status</Field.Label>
  </Field.Root>;
}

export function NumberFieldDemo() {
  return <Field.Root name="preview-seats">
    <Field.Label>Seat count</Field.Label>
    <NumberField.Root defaultValue={5} min={1} max={20}>
      <NumberField.Group>
        <NumberField.Decrement aria-label="Remove one seat">−</NumberField.Decrement>
        <NumberField.Input />
        <NumberField.Increment aria-label="Add one seat">+</NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  </Field.Root>;
}

export function OTPFieldDemo() {
  const [value, setValue] = useState("");
  return <Field.Root name="preview-otp">
    <Field.Label>One-time code</Field.Label>
    <OTPField.Root length={6} value={value} onValueChange={setValue}>
      {Array.from({ length: 6 }, (_, index) => <OTPField.Input key={index}
        aria-label={`Code digit ${index + 1}`} />)}
    </OTPField.Root>
    <Field.Description>Try typing or pasting six digits. No code is sent.</Field.Description>
    <p role="status">{value.length === 6 ? "Code complete" : `${value.length} of 6 digits`}</p>
  </Field.Root>;
}

export function SelectDemo() {
  return <Select.Root items={roles.map((role) => ({ value: role, label: role }))} defaultValue="Reader">
    <Select.Label>Role selection</Select.Label>{" "}
    <Select.Trigger><Select.Value /></Select.Trigger>
    <SelectPopup>
      <Select.List>{roles.map((role) => <Select.Item key={role} value={role}>
        <Select.ItemIndicator aria-hidden="true">✓ </Select.ItemIndicator>
        <Select.ItemText>{role}</Select.ItemText>
      </Select.Item>)}</Select.List>
    </SelectPopup>
  </Select.Root>;
}

export function ComboboxDemo() {
  return <Field.Root name="preview-app">
    <Field.Label>Application</Field.Label>{" "}
    <Combobox.Root items={apps}>
      <Combobox.InputGroup>
        <Combobox.Input placeholder="Choose an application" />
        <Combobox.Trigger aria-label="Show applications"><Icon name="down" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <ComboboxPopup>
        <Combobox.Empty>No applications found</Combobox.Empty>
        <Combobox.List>{(app: string) => <Combobox.Item key={app} value={app}>{app}</Combobox.Item>}</Combobox.List>
      </ComboboxPopup>
    </Combobox.Root>
  </Field.Root>;
}

export function AutocompleteDemo() {
  return <Field.Root name="preview-search">
    <Field.Label>Search applications</Field.Label>{" "}
    <Autocomplete.Root items={apps}>
      <Autocomplete.InputGroup>
        <Autocomplete.Input placeholder="Search applications" />
        <Autocomplete.Trigger aria-label="Show suggestions"><Icon name="down" /></Autocomplete.Trigger>
      </Autocomplete.InputGroup>
      <AutocompletePopup>
        <Autocomplete.Empty>No suggestions</Autocomplete.Empty>
        <Autocomplete.List>{(app: string) => <Autocomplete.Item key={app} value={app}>{app}</Autocomplete.Item>}</Autocomplete.List>
      </AutocompletePopup>
    </Autocomplete.Root>
    <Field.Description>Suggestions are optional; custom text is allowed.</Field.Description>
  </Field.Root>;
}

export function SliderDemo() {
  return <Slider.Root defaultValue={40} min={0} max={100} name="preview-volume">
    <Slider.Label>Notification volume</Slider.Label>{" "}<Slider.Value />
    <Slider.Control data-preview="slider-control">
      <Slider.Track data-preview="slider-track">
        <Slider.Indicator />
        <Slider.Thumb data-preview="slider-thumb" />
      </Slider.Track>
    </Slider.Control>
  </Slider.Root>;
}
