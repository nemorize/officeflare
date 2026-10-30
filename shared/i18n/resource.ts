export type MessageResource = Readonly<Record<string, string>>;
export type TranslationShape<Source extends MessageResource> = {
  readonly [K in keyof Source]: string;
};

type Characters<S extends string> = S extends `${infer First}${infer Rest}`
  ? First | Characters<Rest>
  : never;
type Letter = Characters<"abcdefghijklmnopqrstuvwxyz">;
type IdentifierStart = Letter | Uppercase<Letter> | "_";
type IdentifierPart = IdentifierStart | Characters<"0123456789">;
type IsIdentifierRest<S extends string> = S extends ""
  ? true
  : S extends `${IdentifierPart}${infer Rest}`
    ? IsIdentifierRest<Rest>
    : false;
type IsIdentifier<S extends string> = S extends `${IdentifierStart}${infer Rest}`
  ? IsIdentifierRest<Rest>
  : false;

export type ParameterNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ParameterNames<Rest>
  : never;

type SameNames<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ValidTemplate<S extends string> = string extends S
  ? false
  : S extends `${infer Before}{${infer Name}}${infer Rest}`
    ? Before extends `${string}}${string}`
      ? false
      : IsIdentifier<Name> extends true
        ? ValidTemplate<Rest>
        : false
    : S extends `${string}{${string}` | `${string}}${string}`
      ? false
      : true;

type PluralBase<K> = K extends `${infer Base}.one` | `${infer Base}.other` ? Base : never;
type ValidPlural<Source extends MessageResource, K extends keyof Source> = [PluralBase<K>] extends [
  never,
]
  ? true
  : `${PluralBase<K>}.one` extends keyof Source
    ? `${PluralBase<K>}.other` extends keyof Source
      ? "count" extends ParameterNames<Source[K]>
        ? SameNames<
            ParameterNames<Source[`${PluralBase<K>}.one`]>,
            ParameterNames<Source[`${PluralBase<K>}.other`]>
          >
        : false
      : false
    : false;

type ValidateResource<Source extends MessageResource> = string extends keyof Source
  ? never
  : {
      readonly [K in keyof Source]: K extends string
        ? ValidTemplate<Source[K]> extends true
          ? K extends `labels.${string}`
            ? [ParameterNames<Source[K]>] extends [never]
              ? unknown
              : never
            : ValidPlural<Source, K> extends true
              ? unknown
              : never
          : never
        : never;
    };
type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;
type TranslationMatches<Source extends string, Target extends string> = Target extends unknown
  ? SameNames<ParameterNames<Source>, ParameterNames<Target>>
  : never;
type ValidateTranslation<Source extends MessageResource, Target extends MessageResource> = {
  readonly [K in keyof Target]: K extends keyof Source
    ? [TranslationMatches<Source[K], Target[K]>] extends [true]
      ? unknown
      : never
    : never;
} & Record<Exclude<KeysOfUnion<Target>, keyof Source>, never>;

/** Preserve literal types and check templates, label messages, and plural pairs. */
export function defineMessages<const Source extends MessageResource>(
  messages: Source & ValidateResource<NoInfer<Source>>,
): Readonly<Source> {
  return messages;
}

/** A locale must have exactly the source keys and the same named parameters. */
export function defineTranslations<
  const Source extends MessageResource,
  const Target extends TranslationShape<NoInfer<Source>>,
>(
  source: Source & ValidateResource<NoInfer<Source>>,
  messages: Target &
    ValidateResource<NoInfer<Target>> &
    ValidateTranslation<NoInfer<Source>, NoInfer<Target>>,
): Readonly<Target> {
  return messages;
}
