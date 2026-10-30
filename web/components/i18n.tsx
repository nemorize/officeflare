import { Fragment, type ReactNode } from "react";
import {
  messageParts,
  type ExactMessageParameters,
  type MessageKey,
  type MessageParameters,
} from "../../shared/i18n/index.ts";

/** Preserve links, emphasis, and conditional content in translatable sentences. */
export function LocalizedMessage<
  const K extends MessageKey,
  const Parameters extends MessageParameters<NoInfer<K>, ReactNode>,
>({ id, values }: { id: K; values: ExactMessageParameters<K, Parameters> }) {
  return messageParts(id, values).map((part, index) => <Fragment key={index}>{part}</Fragment>);
}
