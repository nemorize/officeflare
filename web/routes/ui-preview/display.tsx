import { LocalizedMessage } from "../../components/i18n";
import { t } from "../../../shared/i18n/index.ts";
import { useState } from "react";
import {
  Avatar,
  Button,
  Meter,
  Progress,
  ScrollArea,
  Separator,
  Toggle,
  ToggleGroup,
} from "@/components/ui";

const sampleImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><text x="20" y="26" text-anchor="middle">AM</text></svg>')}`;

export function ButtonDemo() {
  const [count, setCount] = useState(0);
  return (
    <>
      <Button variant="primary" onClick={() => setCount((value) => value + 1)}>
        {t("routesUiPreviewDisplay.clickExampleButton")}
      </Button>{" "}
      <Button onClick={() => setCount((value) => value + 1)}>
        {t("routesUiPreviewDisplay.secondary")}
      </Button>{" "}
      <Button variant="subtle" onClick={() => setCount((value) => value + 1)}>
        {t("routesUiPreviewDisplay.subtle")}
      </Button>{" "}
      <Button variant="ghost" onClick={() => setCount((value) => value + 1)}>
        {t("routesUiPreviewDisplay.ghost")}
      </Button>{" "}
      <Button disabled>{t("routesUiPreviewDisplay.disabledButton")}</Button>
      <p role="status">
        <LocalizedMessage id="routesUiPreviewDisplay.clickedTimes" values={{ count: count }} />
      </p>
    </>
  );
}

export function AvatarDemo() {
  return (
    <>
      <Avatar.Root>
        <Avatar.Image
          src={sampleImage}
          alt={t("routesUiPreviewDisplay.alexMorgan")}
          width={40}
          height={40}
        />
        <Avatar.Fallback>{t("routesUiPreviewDisplay.am")}</Avatar.Fallback>
      </Avatar.Root>
      <Avatar.Root aria-label={t("routesUiPreviewDisplay.taylorSmith")}>
        <Avatar.Fallback>{t("routesUiPreviewDisplay.ts")}</Avatar.Fallback>
      </Avatar.Root>
    </>
  );
}

export function ProgressDemo() {
  const [value, setValue] = useState(25);
  return (
    <>
      <Progress.Root value={value}>
        <Progress.Label>{t("routesUiPreviewDisplay.exampleUpload")}</Progress.Label>{" "}
        <Progress.Value />
        <Progress.Track>
          <Progress.Indicator />
        </Progress.Track>
      </Progress.Root>
      <Button
        disabled={value === 100}
        onClick={() => setValue((current) => Math.min(current + 25, 100))}
      >
        {t("routesUiPreviewDisplay.advanceUpload")}
      </Button>{" "}
      <Button onClick={() => setValue(0)}>{t("routesUiPreviewDisplay.resetUpload")}</Button>
    </>
  );
}

export function MeterDemo() {
  const [value, setValue] = useState(60);
  return (
    <>
      <Meter.Root value={value} min={0} max={100}>
        <Meter.Label>{t("routesUiPreviewDisplay.exampleStorageUsage")}</Meter.Label> <Meter.Value />
        <Meter.Track>
          <Meter.Indicator />
        </Meter.Track>
      </Meter.Root>
      <Button onClick={() => setValue((current) => (current + 10) % 110)}>
        {t("routesUiPreviewDisplay.changeStorageUsage")}
      </Button>
    </>
  );
}

export function ScrollAreaDemo() {
  return (
    <ScrollArea.Root data-preview="scroll-area">
      <ScrollArea.Viewport
        data-preview="scroll-viewport"
        aria-label={t("routesUiPreviewDisplay.exampleDirectory")}
        tabIndex={0}
      >
        <ScrollArea.Content>
          <ol>
            {Array.from({ length: 20 }, (_, index) => (
              <li key={index}>
                <LocalizedMessage
                  id="routesUiPreviewDisplay.exampleDirectoryMember"
                  values={{ value1: index + 1 }}
                />
              </li>
            ))}
          </ol>
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar data-preview="scrollbar">
        <ScrollArea.Thumb data-preview="scroll-thumb" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Corner />
    </ScrollArea.Root>
  );
}

export function SeparatorDemo() {
  return (
    <>
      <p>{t("routesUiPreviewDisplay.profileSection")}</p>
      <Separator />
      <p>{t("routesUiPreviewDisplay.securitySection")}</p>
    </>
  );
}

export function ToggleDemo() {
  const [pressed, setPressed] = useState(false);
  return (
    <>
      <Toggle pressed={pressed} onPressedChange={setPressed}>
        {t("routesUiPreviewDisplay.pinExampleItem")}
      </Toggle>
      <p role="status">
        {pressed
          ? t("routesUiPreviewDisplay.itemPinned")
          : t("routesUiPreviewDisplay.itemUnpinned")}
      </p>
    </>
  );
}

export function ToggleGroupDemo() {
  const [value, setValue] = useState<string[]>([t("routesUiPreviewDisplay.list")]);
  return (
    <>
      <ToggleGroup
        value={value}
        onValueChange={setValue}
        aria-label={t("routesUiPreviewDisplay.directoryView")}
      >
        <Toggle value="List">{t("routesUiPreviewDisplay.list")}</Toggle>
        <Toggle value="Grid">{t("routesUiPreviewDisplay.grid")}</Toggle>
      </ToggleGroup>
      <p role="status">
        <LocalizedMessage
          id="routesUiPreviewDisplay.view"
          values={{ value1: value.join(", ") || t("common.none") }}
        />
      </p>
    </>
  );
}
