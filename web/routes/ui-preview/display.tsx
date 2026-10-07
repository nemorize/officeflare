import { useState } from "react";
import { Avatar, Button, Meter, Progress, ScrollArea, Separator, Toggle, ToggleGroup } from "@/components/ui";

const sampleImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><text x="20" y="26" text-anchor="middle">AM</text></svg>')}`;

export function ButtonDemo() {
  const [count, setCount] = useState(0);
  return <>
    <Button variant="primary" onClick={() => setCount((value) => value + 1)}>Click example button</Button>{" "}
    <Button onClick={() => setCount((value) => value + 1)}>Secondary</Button>{" "}
    <Button variant="subtle" onClick={() => setCount((value) => value + 1)}>Subtle</Button>{" "}
    <Button variant="ghost" onClick={() => setCount((value) => value + 1)}>Ghost</Button>{" "}
    <Button disabled>Disabled button</Button>
    <p role="status">Clicked {count} times</p>
  </>;
}

export function AvatarDemo() {
  return <>
    <Avatar.Root>
      <Avatar.Image src={sampleImage} alt="Alex Morgan" width={40} height={40} />
      <Avatar.Fallback>AM</Avatar.Fallback>
    </Avatar.Root>
    <Avatar.Root aria-label="Taylor Smith">
      <Avatar.Fallback>TS</Avatar.Fallback>
    </Avatar.Root>
  </>;
}

export function ProgressDemo() {
  const [value, setValue] = useState(25);
  return <>
    <Progress.Root value={value}>
      <Progress.Label>Example upload</Progress.Label>{" "}<Progress.Value />
      <Progress.Track><Progress.Indicator /></Progress.Track>
    </Progress.Root>
    <Button disabled={value === 100} onClick={() => setValue((current) => Math.min(current + 25, 100))}>Advance upload</Button>{" "}
    <Button onClick={() => setValue(0)}>Reset upload</Button>
  </>;
}

export function MeterDemo() {
  const [value, setValue] = useState(60);
  return <>
    <Meter.Root value={value} min={0} max={100}>
      <Meter.Label>Example storage usage</Meter.Label>{" "}<Meter.Value />
      <Meter.Track><Meter.Indicator /></Meter.Track>
    </Meter.Root>
    <Button onClick={() => setValue((current) => (current + 10) % 110)}>Change storage usage</Button>
  </>;
}

export function ScrollAreaDemo() {
  return <ScrollArea.Root data-preview="scroll-area">
    <ScrollArea.Viewport data-preview="scroll-viewport" aria-label="Example directory" tabIndex={0}>
      <ScrollArea.Content>
        <ol>{Array.from({ length: 20 }, (_, index) => <li key={index}>Example directory member {index + 1}</li>)}</ol>
      </ScrollArea.Content>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar data-preview="scrollbar"><ScrollArea.Thumb data-preview="scroll-thumb" /></ScrollArea.Scrollbar>
    <ScrollArea.Corner />
  </ScrollArea.Root>;
}

export function SeparatorDemo() {
  return <><p>Profile section</p><Separator /><p>Security section</p></>;
}

export function ToggleDemo() {
  const [pressed, setPressed] = useState(false);
  return <>
    <Toggle pressed={pressed} onPressedChange={setPressed}>Pin example item</Toggle>
    <p role="status">{pressed ? "Item pinned" : "Item unpinned"}</p>
  </>;
}

export function ToggleGroupDemo() {
  const [value, setValue] = useState<string[]>(["List"]);
  return <>
    <ToggleGroup value={value} onValueChange={setValue} aria-label="Directory view">
      <Toggle value="List">List</Toggle><Toggle value="Grid">Grid</Toggle>
    </ToggleGroup>
    <p role="status">View: {value.join(", ") || "None"}</p>
  </>;
}
