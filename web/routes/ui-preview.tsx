import { useState, type ComponentType } from "react";
import { Link } from "react-router";
import { Button, TextField } from "@/components/ui";
import * as Forms from "./ui-preview/forms";
import * as Popups from "./ui-preview/popups";
import * as Navigation from "./ui-preview/navigation";
import * as Display from "./ui-preview/display";
import "./ui-preview/styles.css";

interface Example {
  name: string;
  slug: string;
  component: ComponentType;
}

const groups: { name: string; examples: Example[] }[] = [
  { name: "Form controls", examples: [
    { name: "Autocomplete", slug: "autocomplete", component: Forms.AutocompleteDemo },
    { name: "Checkbox", slug: "checkbox", component: Forms.CheckboxDemo },
    { name: "Checkbox Group", slug: "checkbox-group", component: Forms.CheckboxGroupDemo },
    { name: "Combobox", slug: "combobox", component: Forms.ComboboxDemo },
    { name: "Field", slug: "field", component: Forms.FieldDemo },
    { name: "Fieldset", slug: "fieldset", component: Forms.FieldsetDemo },
    { name: "Form", slug: "form", component: Forms.FormDemo },
    { name: "Input", slug: "input", component: Forms.InputDemo },
    { name: "Number Field", slug: "number-field", component: Forms.NumberFieldDemo },
    { name: "OTP Field", slug: "otp-field", component: Forms.OTPFieldDemo },
    { name: "Radio Group", slug: "radio-group", component: Forms.RadioGroupDemo },
    { name: "Select", slug: "select", component: Forms.SelectDemo },
    { name: "Slider", slug: "slider", component: Forms.SliderDemo },
    { name: "Switch", slug: "switch", component: Forms.SwitchDemo },
  ] },
  { name: "Popups and notifications", examples: [
    { name: "Alert Dialog", slug: "alert-dialog", component: Popups.AlertDialogDemo },
    { name: "Context Menu", slug: "context-menu", component: Popups.ContextMenuDemo },
    { name: "Dialog", slug: "dialog", component: Popups.DialogDemo },
    { name: "Drawer", slug: "drawer", component: Popups.DrawerDemo },
    { name: "Menu", slug: "menu", component: Popups.MenuDemo },
    { name: "Popover", slug: "popover", component: Popups.PopoverDemo },
    { name: "Preview Card", slug: "preview-card", component: Popups.PreviewCardDemo },
    { name: "Toast", slug: "toast", component: Popups.ToastDemo },
    { name: "Tooltip", slug: "tooltip", component: Popups.TooltipDemo },
  ] },
  { name: "Navigation and disclosure", examples: [
    { name: "Accordion", slug: "accordion", component: Navigation.AccordionDemo },
    { name: "Collapsible", slug: "collapsible", component: Navigation.CollapsibleDemo },
    { name: "Menubar", slug: "menubar", component: Navigation.MenubarDemo },
    { name: "Navigation Menu", slug: "navigation-menu", component: Navigation.NavigationMenuDemo },
    { name: "Tabs", slug: "tabs", component: Navigation.TabsDemo },
    { name: "Toolbar", slug: "toolbar", component: Navigation.ToolbarDemo },
  ] },
  { name: "Actions and display", examples: [
    { name: "Avatar", slug: "avatar", component: Display.AvatarDemo },
    { name: "Button", slug: "button", component: Display.ButtonDemo },
    { name: "Meter", slug: "meter", component: Display.MeterDemo },
    { name: "Progress", slug: "progress", component: Display.ProgressDemo },
    { name: "Scroll Area", slug: "scroll-area", component: Display.ScrollAreaDemo },
    { name: "Separator", slug: "separator", component: Display.SeparatorDemo },
    { name: "Toggle", slug: "toggle", component: Display.ToggleDemo },
    { name: "Toggle Group", slug: "toggle-group", component: Display.ToggleGroupDemo },
  ] },
];

const total = groups.reduce((count, group) => count + group.examples.length, 0);

// Loaded only by the development router; examples never call account APIs.
export default function UIPreviewPage() {
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const visibleGroups = groups.map((group) => ({ ...group,
    examples: group.examples.filter(({ name, slug }) => `${name} ${slug}`.toLowerCase().includes(search)),
  })).filter((group) => group.examples.length > 0);
  const visibleCount = visibleGroups.reduce((count, group) => count + group.examples.length, 0);

  return <main>
    <h1>UI components</h1>
    <p>All {total} Base UI component families. Unstyled examples for keyboard, focus and form behavior.</p>
    <Link to="/login">Go to sign in</Link>
    <TextField label="Search components" name="component-search" value={query} onValueChange={setQuery} />
    <Button onClick={() => setQuery("")} disabled={!query}>Clear search</Button>
    <p role="status">Showing {visibleCount} of {total} components</p>
    <nav aria-label="Component examples">
      <ul>{visibleGroups.flatMap((group) => group.examples).map(({ name, slug }) =>
        <li key={slug}><a href={`#demo-${slug}`}>{name}</a></li>)}</ul>
    </nav>
    {visibleGroups.map((group) => <section key={group.name}>
      <h2>{group.name}</h2>
      {group.examples.map(({ name, slug, component: Demo }) => <section key={slug} id={`demo-${slug}`} aria-labelledby={`heading-${slug}`}>
        <h3 id={`heading-${slug}`}>{name}</h3>
        <Demo />
        <p><a href={`https://base-ui.com/react/components/${slug}`} target="_blank" rel="noreferrer">{name} documentation</a></p>
      </section>)}
    </section>)}
    {visibleCount === 0 && <p>No components match your search.</p>}
  </main>;
}
