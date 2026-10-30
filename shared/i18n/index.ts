import { en } from "./en.ts";
import type { ParameterNames, TranslationShape } from "./resource.ts";
export { defineMessages, defineTranslations } from "./resource.ts";

export const locale = "en";
export type MessageKey = keyof typeof en;
export type Messages = TranslationShape<typeof en>;
export type InterpolationValue = string | number;
export type MessageParameterNames<K extends MessageKey> = ParameterNames<(typeof en)[K]>;
export type MessageParameters<K extends MessageKey, Value = InterpolationValue> = Record<
  MessageParameterNames<K>,
  Value
>;
type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;
type ExactParameters<Names extends PropertyKey, Parameters> = Parameters &
  Record<Exclude<KeysOfUnion<Parameters>, Names>, never>;
export type ExactMessageParameters<K extends MessageKey, Parameters> = ExactParameters<
  MessageParameterNames<K>,
  Parameters
>;
export type StaticMessageKey = {
  [K in MessageKey]: [MessageParameterNames<K>] extends [never] ? K : never;
}[MessageKey];
type PluralMessageKey = {
  [K in MessageKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends MessageKey
      ? Base
      : never
    : never;
}[MessageKey];
type PluralParameterNames<K extends PluralMessageKey> = Exclude<
  MessageParameterNames<`${K}.one`>,
  "count"
>;

export const messageTemplate = <K extends MessageKey>(key: K): (typeof en)[K] => en[key];
export const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(en, key);
export const isStaticMessageKey = (key: string): key is StaticMessageKey =>
  isMessageKey(key) && !/\{[A-Za-z_]\w*\}/.test(messageTemplate(key));

function hasOwn<ObjectType extends object>(
  object: ObjectType,
  key: PropertyKey,
): key is keyof ObjectType {
  return Object.hasOwn(object, key);
}

/** Substitute once; user text is never interpreted as a template or HTML. */
function format(template: string, parameters: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{([A-Za-z_]\w*)\}/g, (placeholder, name: string) =>
    hasOwn(parameters, name) ? String(parameters[name]) : placeholder,
  );
}

const pluralRules = new Intl.PluralRules(locale);
export function plural<
  const K extends PluralMessageKey,
  const Parameters extends Record<PluralParameterNames<NoInfer<K>>, InterpolationValue>,
>(
  key: K,
  count: number,
  ...[parameters]: [PluralParameterNames<K>] extends [never]
    ? []
    : [parameters: ExactParameters<PluralParameterNames<K>, Parameters>]
): string {
  const form = pluralRules.select(count) === "one" ? "one" : "other";
  return format(messageTemplate(`${key}.${form}`), { ...parameters, count });
}

export function messageParts<
  const K extends MessageKey,
  const Parameters extends MessageParameters<NoInfer<K>, unknown>,
>(
  key: K,
  parameters: ExactMessageParameters<K, Parameters>,
): (string | Parameters[keyof Parameters])[] {
  return en[key].split(/(\{[A-Za-z_]\w*\})/g).map((part) => {
    const name = part.slice(1, -1);
    return /^\{[A-Za-z_]\w*\}$/.test(part) && hasOwn(parameters, name) ? parameters[name] : part;
  });
}

export function t<
  const K extends MessageKey,
  const Parameters extends MessageParameters<NoInfer<K>>,
>(
  key: K,
  ...[parameters]: [MessageParameterNames<K>] extends [never]
    ? []
    : [parameters: ExactMessageParameters<K, Parameters>]
): string {
  return format(en[key], parameters ?? {});
}
