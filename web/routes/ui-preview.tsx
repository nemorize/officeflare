import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router";
import {
  Button,
  Icon,
  OfficeflareMark,
  Select,
  SelectPopup,
  SearchField,
  Input,
} from "@/components/ui";
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
  {
    name: "Form controls",
    examples: [
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
    ],
  },
  {
    name: "Popups and notifications",
    examples: [
      { name: "Alert Dialog", slug: "alert-dialog", component: Popups.AlertDialogDemo },
      { name: "Context Menu", slug: "context-menu", component: Popups.ContextMenuDemo },
      { name: "Dialog", slug: "dialog", component: Popups.DialogDemo },
      { name: "Drawer", slug: "drawer", component: Popups.DrawerDemo },
      { name: "Menu", slug: "menu", component: Popups.MenuDemo },
      { name: "Popover", slug: "popover", component: Popups.PopoverDemo },
      { name: "Preview Card", slug: "preview-card", component: Popups.PreviewCardDemo },
      { name: "Toast", slug: "toast", component: Popups.ToastDemo },
      { name: "Tooltip", slug: "tooltip", component: Popups.TooltipDemo },
    ],
  },
  {
    name: "Navigation and disclosure",
    examples: [
      { name: "Accordion", slug: "accordion", component: Navigation.AccordionDemo },
      { name: "Collapsible", slug: "collapsible", component: Navigation.CollapsibleDemo },
      { name: "Menubar", slug: "menubar", component: Navigation.MenubarDemo },
      {
        name: "Navigation Menu",
        slug: "navigation-menu",
        component: Navigation.NavigationMenuDemo,
      },
      { name: "Tabs", slug: "tabs", component: Navigation.TabsDemo },
      { name: "Toolbar", slug: "toolbar", component: Navigation.ToolbarDemo },
    ],
  },
  {
    name: "Actions and display",
    examples: [
      { name: "Avatar", slug: "avatar", component: Display.AvatarDemo },
      { name: "Button", slug: "button", component: Display.ButtonDemo },
      { name: "Meter", slug: "meter", component: Display.MeterDemo },
      { name: "Progress", slug: "progress", component: Display.ProgressDemo },
      { name: "Scroll Area", slug: "scroll-area", component: Display.ScrollAreaDemo },
      { name: "Separator", slug: "separator", component: Display.SeparatorDemo },
      { name: "Toggle", slug: "toggle", component: Display.ToggleDemo },
      { name: "Toggle Group", slug: "toggle-group", component: Display.ToggleGroupDemo },
    ],
  },
];

const total = groups.reduce((count, group) => count + group.examples.length, 0);

const groupIcons = ["controls", "layers", "navigation", "circle"] as const;
const categoryItems = [
  { value: "all", label: "All components" },
  ...groups.map(({ name }) => ({ value: name, label: name })),
];

function ComponentSearch({
  query,
  onChange,
  mobile = false,
}: {
  query: string;
  onChange: (query: string) => void;
  mobile?: boolean;
}) {
  return (
    <SearchField
      className={`gallery-search ${mobile ? "gallery-search-mobile" : ""}`}
      onSubmit={(event) => event.preventDefault()}
    >
      <Icon name="search" />
      <Input
        variant="integrated"
        aria-label="Search components"
        name={mobile ? "component-search-mobile" : "component-search"}
        value={query}
        onValueChange={onChange}
        placeholder="Search components"
      />
      {query && (
        <Button size="icon" variant="ghost" onClick={() => onChange("")} aria-label="Clear search">
          <Icon name="close" width="13" height="13" />
        </Button>
      )}
    </SearchField>
  );
}

// Loaded only by the development router; examples never call account APIs.
export default function UIPreviewPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [active, setActive] = useState("");
  const search = query.trim().toLowerCase();
  const visibleGroups = groups
    .filter((group) => category === "all" || group.name === category)
    .map((group) => ({
      ...group,
      examples: group.examples.filter(({ name, slug }) =>
        `${name} ${slug}`.toLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.examples.length > 0);
  const visibleCount = visibleGroups.reduce((count, group) => count + group.examples.length, 0);

  useEffect(() => {
    document.title = "UI components · Officeflare";
    document.querySelector(".gallery-workspace")?.scrollTo({ top: 0, behavior: "instant" });
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.isIntersecting);
        if (entry) setActive(entry.target.id.replace("demo-", ""));
      },
      { root: document.querySelector(".gallery-workspace"), rootMargin: "-100px 0px -65% 0px" },
    );
    document.querySelectorAll(".component-example").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [query, category]);

  return (
    <div className="gallery-shell">
      <aside className="gallery-rail" aria-label="Library categories">
        <a href="#gallery-main" className="gallery-mark" aria-label="Officeflare component library">
          <OfficeflareMark />
        </a>
        <Button
          variant="ghost"
          size="icon"
          aria-label="All components"
          aria-pressed={category === "all"}
          onClick={() => setCategory("all")}
        >
          <Icon name="grid" />
        </Button>
        {groups.map((group, index) => (
          <Button
            key={group.name}
            variant="ghost"
            size="icon"
            aria-label={group.name}
            aria-pressed={category === group.name}
            onClick={() => setCategory(group.name)}
          >
            <Icon name={groupIcons[index]!} />
          </Button>
        ))}
        <Link to="/login" className="gallery-rail-account" aria-label="Go to sign in">
          <Icon name="user" />
        </Link>
      </aside>
      <div className="gallery-frame">
        <aside className="gallery-sidebar">
          <div className="gallery-sidebar-header">
            <div className="gallery-sidebar-title">
              Components<span className="gallery-count">{total}</span>
            </div>
            <ComponentSearch query={query} onChange={setQuery} />
          </div>
          <nav aria-label="Component examples" className="gallery-nav">
            {visibleGroups.map((group) => (
              <div className="gallery-nav-group" key={group.name}>
                <h2>{group.name}</h2>
                {group.examples.map(({ name, slug }) => (
                  <a
                    key={slug}
                    href={`#demo-${slug}`}
                    aria-current={active === slug ? "location" : undefined}
                    onClick={() => setActive(slug)}
                  >
                    {name}
                  </a>
                ))}
              </div>
            ))}
            {visibleCount === 0 && <p className="gallery-sidebar-empty">No matching components</p>}
          </nav>
          <div className="gallery-sidebar-footer">
            <Icon name="code" />
            <span>Officeflare UI</span>
          </div>
        </aside>
        <div className="gallery-workspace">
          <header className="gallery-topbar">
            <div className="gallery-breadcrumb">
              <span>Officeflare</span>
              <Icon name="chevron" width="12" height="12" />
              <span>Component library</span>
            </div>
            <Link to="/login" className="gallery-sign-in">
              Go to sign in
              <Icon name="arrow" width="14" height="14" />
            </Link>
          </header>
          <main className="gallery-main" id="gallery-main">
            <div className="gallery-intro">
              <h1>UI components</h1>
              <p>Common building blocks for a consistent workspace.</p>
            </div>
            <div className="gallery-filter-bar">
              <p role="status">
                Showing {visibleCount} of {total} components
              </p>
              <Select.Root
                items={categoryItems}
                value={category}
                onValueChange={(value) => setCategory(value ?? "all")}
              >
                <Select.Label className="visually-hidden">Component category</Select.Label>
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <SelectPopup>
                  <Select.List>
                    {categoryItems.map(({ value, label }) => (
                      <Select.Item key={value} value={value}>
                        <Select.ItemText>{label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </SelectPopup>
              </Select.Root>
            </div>
            <ComponentSearch query={query} onChange={setQuery} mobile />
            {visibleGroups.map((group) => (
              <section className="component-group" key={group.name}>
                <h2>{group.name}</h2>
                <div className="component-panel">
                  {group.examples.map(({ name, slug, component: Demo }) => (
                    <section
                      className="component-example"
                      key={slug}
                      id={`demo-${slug}`}
                      aria-labelledby={`heading-${slug}`}
                    >
                      <div className="component-heading">
                        <h3 id={`heading-${slug}`}>{name}</h3>
                        <a
                          className="component-docs"
                          href={`https://base-ui.com/react/components/${slug}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`${name} documentation`}
                          title={`${name} documentation`}
                        >
                          <Icon name="external" width="13" height="13" />
                        </a>
                      </div>
                      <div className="component-body">
                        <Demo />
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            ))}
            {visibleCount === 0 && (
              <div className="gallery-empty">
                <Icon name="search" width="24" height="24" />
                <h2>No components match your search.</h2>
                <p>Try a different name or reset the filters.</p>
                <Button
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  Reset filters
                </Button>
              </div>
            )}
            <footer className="gallery-content-footer">
              Officeflare component library<span>Built with Base UI</span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
