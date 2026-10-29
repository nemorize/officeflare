import type { MessageSizeBreakdown } from "../../src/mail/size";
import { bytes } from "../lib/mail";
import { Button, Icon, Popover, PopoverPopup } from "./ui";

export function MailMessageSize({
  size,
  maximum,
  uploadMaximum,
}: {
  size: MessageSizeBreakdown;
  maximum: number;
  uploadMaximum: number;
}) {
  const percentage = maximum > 0 ? (size.total / maximum) * 100 : null;
  const percentLabel =
    percentage === null
      ? null
      : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percentage)}%`;
  const usage =
    percentage === null
      ? "unknown"
      : size.total > maximum
        ? "over"
        : percentage >= 90
          ? "near"
          : "normal";
  const label = `Message size: ${bytes(size.total)}${maximum > 0 ? ` of ${bytes(maximum)}, ${percentLabel} used` : ", sending limit unavailable"}`;

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            size="icon"
            variant="ghost"
            className="mail-size-trigger"
            data-usage={usage}
            aria-label={label}
          />
        }
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <circle className="mail-size-track" cx="12" cy="12" r="9" />
          {percentage !== null && (
            <circle
              className="mail-size-arc"
              cx="12"
              cy="12"
              r="9"
              pathLength="100"
              strokeDasharray={`${Math.min(100, percentage)} 100`}
              strokeLinecap="round"
              transform="rotate(-90 12 12)"
            />
          )}
        </svg>
      </Popover.Trigger>
      <PopoverPopup
        className="mail-size-popup"
        data-usage={usage}
        positionerProps={{ side: "top", align: "end", sideOffset: 8 }}
        initialFocus={false}
      >
        <header className="mail-size-heading">
          <Popover.Title>Message size</Popover.Title>
          <Popover.Close
            render={<Button size="icon" variant="ghost" aria-label="Close message size details" />}
          >
            <Icon name="close" />
          </Popover.Close>
        </header>
        <Popover.Description>Estimated sending size</Popover.Description>
        <div className="mail-size-summary">
          <strong>
            {bytes(size.total)}
            {maximum > 0 && <span> / {bytes(maximum)}</span>}
          </strong>
          {percentLabel && <span className="mail-size-percentage">{percentLabel} used</span>}
        </div>
        <dl className="mail-size-breakdown">
          {(
            [
              ["Subject", size.subject],
              ["Body", size.body],
              ["Images", size.images],
              ["Attachments", size.attachments],
              ["Headers & formatting", size.headers],
            ] as const
          ).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{bytes(value)}</dd>
            </div>
          ))}
        </dl>
        {uploadMaximum > 0 && (
          <p className="mail-size-note">Per file limit: {bytes(uploadMaximum)}</p>
        )}
        {maximum <= 0 && <p className="mail-size-note">Sending limit unavailable.</p>}
      </PopoverPopup>
    </Popover.Root>
  );
}
