import { LocalizedMessage } from "../../components/i18n";
import { t } from "../../../shared/i18n/index.ts";
import { useRef, useState } from "react";
import {
  Autocomplete,
  AutocompletePopup,
  Button,
  Checkbox,
  CheckboxGroup,
  Combobox,
  ComboboxPopup,
  Field,
  Fieldset,
  Form,
  Icon,
  Input,
  NumberField,
  OTPField,
  Radio,
  RadioGroup,
  Select,
  SelectPopup,
  Slider,
  Switch,
  TextField,
} from "@/components/ui";

const apps = [
  t("routesUiPreviewForms.calendar"),
  t("routesUiPreviewForms.files"),
  t("routesUiPreviewForms.mail"),
];
const roles = [
  t("routesUiPreviewForms.reader"),
  t("routesUiPreviewForms.editor"),
  t("routesUiPreviewForms.administrator"),
];

export function InputDemo() {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <label htmlFor="preview-input">{t("routesUiPreviewForms.displayName")}</label>{" "}
      <Input ref={input} id="preview-input" placeholder={t("routesUiPreviewForms.yourName")} />{" "}
      <Button onClick={() => input.current?.focus()}>{t("routesUiPreviewForms.focusInput")}</Button>
    </>
  );
}

export function FieldDemo() {
  return (
    <Field.Root name="preview-field" validationMode="onBlur">
      <Field.Label>{t("routesUiPreviewForms.contactEmail")}</Field.Label>{" "}
      <Input type="email" required />
      <Field.Description>
        {t("routesUiPreviewForms.enterAnEmailAddressThenMoveFocusToValidate")}
      </Field.Description>
      <Field.Error />
    </Field.Root>
  );
}

export function FieldsetDemo() {
  return (
    <Fieldset.Root>
      <Fieldset.Legend>{t("routesUiPreviewForms.contactDetails")}</Fieldset.Legend>
      <TextField label={t("routesUiPreviewForms.givenName")} name="preview-given-name" />
      <TextField label={t("routesUiPreviewForms.familyName")} name="preview-family-name" />
    </Fieldset.Root>
  );
}

export function FormDemo() {
  const [result, setResult] = useState("");
  return (
    <Form
      onFormSubmit={(values) =>
        setResult(
          t("routesUiPreviewForms.submitted", {
            String: String(values["preview-form-email"] ?? ""),
          }),
        )
      }
    >
      <TextField
        name="preview-form-email"
        label={t("routesUiPreviewForms.emailForPreviewForm")}
        type="email"
        required
        description={t("routesUiPreviewForms.onlyLocalDemoStateIsUpdated")}
      />
      <Button type="submit" variant="primary">
        {t("routesUiPreviewForms.submitPreviewForm")}
      </Button>
      <p role="status">{result}</p>
    </Form>
  );
}

export function CheckboxDemo() {
  return (
    <Field.Root name="preview-notifications">
      <Field.Label>
        <Checkbox.Root>
          <Checkbox.Indicator aria-hidden="true">
            {t("routesUiPreviewForms.text")}
          </Checkbox.Indicator>
        </Checkbox.Root>
        {t("routesUiPreviewForms.enableNotifications")}
      </Field.Label>
    </Field.Root>
  );
}

export function CheckboxGroupDemo() {
  const [value, setValue] = useState([t("routesUiPreviewForms.mail")]);
  return (
    <Fieldset.Root>
      <Fieldset.Legend>{t("routesUiPreviewForms.enabledApplications")}</Fieldset.Legend>
      <CheckboxGroup
        value={value}
        onValueChange={setValue}
        aria-label={t("routesUiPreviewForms.enabledApplications")}
      >
        {apps.map((app) => (
          <label key={app}>
            <Checkbox.Root value={app}>
              <Checkbox.Indicator aria-hidden="true">
                {t("routesUiPreviewForms.text")}
              </Checkbox.Indicator>
            </Checkbox.Root>{" "}
            {app}{" "}
          </label>
        ))}
      </CheckboxGroup>
      <p role="status">
        <LocalizedMessage
          id="routesUiPreviewForms.selected"
          values={{ value1: value.join(", ") || t("common.none") }}
        />
      </p>
    </Fieldset.Root>
  );
}

export function RadioGroupDemo() {
  const [value, setValue] = useState(t("routesUiPreviewForms.reader"));
  return (
    <Fieldset.Root>
      <Fieldset.Legend>{t("routesUiPreviewForms.exampleRole")}</Fieldset.Legend>
      <RadioGroup
        value={value}
        onValueChange={setValue}
        aria-label={t("routesUiPreviewForms.exampleRole")}
      >
        {roles.map((role) => (
          <label key={role}>
            <Radio.Root value={role}>
              <Radio.Indicator aria-hidden="true">
                {t("routesUiPreviewForms.text2")}
              </Radio.Indicator>
            </Radio.Root>{" "}
            {role}{" "}
          </label>
        ))}
      </RadioGroup>
      <p role="status">
        <LocalizedMessage id="routesUiPreviewForms.role" values={{ value: value }} />
      </p>
    </Fieldset.Root>
  );
}

export function SwitchDemo() {
  const [checked, setChecked] = useState(false);
  return (
    <Field.Root name="preview-presence">
      <Field.Label>
        <Switch.Root checked={checked} onCheckedChange={setChecked}>
          <Switch.Thumb />
        </Switch.Root>
        {t("routesUiPreviewForms.showOnlineStatus")}
      </Field.Label>
    </Field.Root>
  );
}

export function NumberFieldDemo() {
  return (
    <Field.Root name="preview-seats">
      <Field.Label>{t("routesUiPreviewForms.seatCount")}</Field.Label>
      <NumberField.Root defaultValue={5} min={1} max={20}>
        <NumberField.Group>
          <NumberField.Decrement aria-label={t("routesUiPreviewForms.removeOneSeat")}>
            {t("routesUiPreviewForms.text3")}
          </NumberField.Decrement>
          <NumberField.Input />
          <NumberField.Increment aria-label={t("routesUiPreviewForms.addOneSeat")}>
            {t("routesUiPreviewForms.text4")}
          </NumberField.Increment>
        </NumberField.Group>
      </NumberField.Root>
    </Field.Root>
  );
}

export function OTPFieldDemo() {
  const [value, setValue] = useState("");
  return (
    <Field.Root name="preview-otp">
      <Field.Label>{t("routesUiPreviewForms.oneTimeCode")}</Field.Label>
      <OTPField.Root length={6} value={value} onValueChange={setValue}>
        {Array.from({ length: 6 }, (_, index) => (
          <OTPField.Input
            key={index}
            aria-label={t("routesUiPreviewForms.codeDigit", { value1: index + 1 })}
          />
        ))}
      </OTPField.Root>
      <Field.Description>
        {t("routesUiPreviewForms.tryTypingOrPastingSixDigitsNoCodeIs")}
      </Field.Description>
      <p role="status">
        {value.length === 6
          ? t("routesUiPreviewForms.codeComplete")
          : t("routesUiPreviewForms.of6Digits", { length: value.length })}
      </p>
    </Field.Root>
  );
}

export function SelectDemo() {
  return (
    <Select.Root items={roles.map((role) => ({ value: role, label: role }))} defaultValue="Reader">
      <Select.Label>{t("routesUiPreviewForms.roleSelection")}</Select.Label>{" "}
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <SelectPopup>
        <Select.List>
          {roles.map((role) => (
            <Select.Item key={role} value={role}>
              <Select.ItemIndicator aria-hidden="true">
                {t("routesUiPreviewForms.text5")}
              </Select.ItemIndicator>
              <Select.ItemText>{role}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.List>
      </SelectPopup>
    </Select.Root>
  );
}

export function ComboboxDemo() {
  return (
    <Field.Root name="preview-app">
      <Field.Label>{t("routesUiPreviewForms.application")}</Field.Label>{" "}
      <Combobox.Root items={apps}>
        <Combobox.InputGroup>
          <Combobox.Input placeholder={t("routesUiPreviewForms.chooseAnApplication")} />
          <Combobox.Trigger aria-label={t("routesUiPreviewForms.showApplications")}>
            <Icon name="down" />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <ComboboxPopup>
          <Combobox.Empty>{t("routesUiPreviewForms.noApplicationsFound")}</Combobox.Empty>
          <Combobox.List>
            {(app: string) => (
              <Combobox.Item key={app} value={app}>
                {app}
              </Combobox.Item>
            )}
          </Combobox.List>
        </ComboboxPopup>
      </Combobox.Root>
    </Field.Root>
  );
}

export function AutocompleteDemo() {
  return (
    <Field.Root name="preview-search">
      <Field.Label>{t("routesUiPreviewForms.searchApplications")}</Field.Label>{" "}
      <Autocomplete.Root items={apps}>
        <Autocomplete.InputGroup>
          <Autocomplete.Input placeholder={t("routesUiPreviewForms.searchApplications")} />
          <Autocomplete.Trigger aria-label={t("routesUiPreviewForms.showSuggestions")}>
            <Icon name="down" />
          </Autocomplete.Trigger>
        </Autocomplete.InputGroup>
        <AutocompletePopup>
          <Autocomplete.Empty>{t("routesUiPreviewForms.noSuggestions")}</Autocomplete.Empty>
          <Autocomplete.List>
            {(app: string) => (
              <Autocomplete.Item key={app} value={app}>
                {app}
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </AutocompletePopup>
      </Autocomplete.Root>
      <Field.Description>
        {t("routesUiPreviewForms.suggestionsAreOptionalCustomTextIsAllowed")}
      </Field.Description>
    </Field.Root>
  );
}

export function SliderDemo() {
  return (
    <Slider.Root defaultValue={40} min={0} max={100} name="preview-volume">
      <Slider.Label>{t("routesUiPreviewForms.notificationVolume")}</Slider.Label> <Slider.Value />
      <Slider.Control data-preview="slider-control">
        <Slider.Track data-preview="slider-track">
          <Slider.Indicator />
          <Slider.Thumb data-preview="slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
