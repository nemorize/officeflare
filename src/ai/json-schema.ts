import { fail } from "./errors";
import { canonical } from "./store";
import type { ObjectValue } from "./types";

const keywords = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minProperties",
  "maxProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);
export function assertSchema(schema: unknown, depth = 0): asserts schema is ObjectValue {
  if (typeof schema === "boolean") return;
  if (depth > 20 || !schema || typeof schema !== "object" || Array.isArray(schema))
    fail(400, "AI_INVALID_SCHEMA");
  const value = schema as ObjectValue;
  if (Object.keys(value).some((key) => !keywords.has(key))) fail(400, "AI_INVALID_SCHEMA");
  if (value.$ref !== undefined && (typeof value.$ref !== "string" || !value.$ref.startsWith("#/")))
    fail(400, "AI_INVALID_SCHEMA");
  if (
    value.type !== undefined &&
    !(Array.isArray(value.type) ? value.type : [value.type]).every((type) =>
      ["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)),
    )
  )
    fail(400, "AI_INVALID_SCHEMA");
  for (const key of ["properties", "$defs", "definitions"])
    if (value[key] !== undefined) {
      const children = value[key];
      if (!children || typeof children !== "object" || Array.isArray(children))
        fail(400, "AI_INVALID_SCHEMA");
      for (const child of Object.values(children)) assertSchema(child, depth + 1);
    }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > 64) fail(400, "AI_INVALID_SCHEMA");
      for (const child of value[key]) assertSchema(child, depth + 1);
    }
  for (const key of ["items", "not", "additionalProperties"])
    if (value[key] !== undefined) assertSchema(value[key], depth + 1);
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) || !value.required.every((key) => typeof key === "string"))
  )
    fail(400, "AI_INVALID_SCHEMA");
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 1000)
  )
    fail(400, "AI_INVALID_SCHEMA");
  for (const key of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ])
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    )
      fail(400, "AI_INVALID_SCHEMA");
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      fail(400, "AI_INVALID_SCHEMA");
}
export function schemaMatches(schema: any, value: unknown, root = schema, depth = 0): boolean {
  if (schema === true) return true;
  if (schema === false || depth > 30) return false;
  if (schema.$ref) {
    let target = root;
    for (const key of schema.$ref
      .slice(2)
      .split("/")
      .map((part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (!target || !Object.hasOwn(target, key)) return false;
      target = target[key];
    }
    if (!schemaMatches(target, value, root, depth + 1)) return false;
  }
  if (schema.enum && !schema.enum.some((entry: unknown) => canonical(entry) === canonical(value)))
    return false;
  if (Object.hasOwn(schema, "const") && canonical(schema.const) !== canonical(value)) return false;
  if (
    schema.anyOf &&
    !schema.anyOf.some((entry: unknown) => schemaMatches(entry, value, root, depth + 1))
  )
    return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((entry: unknown) => schemaMatches(entry, value, root, depth + 1)).length !==
      1
  )
    return false;
  if (
    schema.allOf &&
    !schema.allOf.every((entry: unknown) => schemaMatches(entry, value, root, depth + 1))
  )
    return false;
  if (schema.not && schemaMatches(schema.not, value, root, depth + 1)) return false;
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    schema.type &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(
      (type: string) => type === actualType || (type === "integer" && Number.isSafeInteger(value)),
    )
  )
    return false;
  if (
    typeof value === "string" &&
    (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 1000000))
  )
    return false;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity) ||
      value <= (schema.exclusiveMinimum ?? -Infinity) ||
      value >= (schema.exclusiveMaximum ?? Infinity))
  )
    return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000))
      return false;
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) return false;
    for (const [index, entry] of value.entries())
      if (
        !schemaMatches(schema.prefixItems?.[index] ?? schema.items ?? true, entry, root, depth + 1)
      )
        return false;
  } else if (value !== null && typeof value === "object") {
    const properties = value as ObjectValue,
      keys = Object.keys(properties);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? 1000))
      return false;
    if ((schema.required ?? []).some((key: string) => !Object.hasOwn(properties, key)))
      return false;
    for (const key of keys)
      if (
        !schemaMatches(
          Object.hasOwn(schema.properties ?? {}, key)
            ? schema.properties[key]
            : (schema.additionalProperties ?? true),
          properties[key],
          root,
          depth + 1,
        )
      )
        return false;
  }
  return true;
}
export function validateSchema(schema: ObjectValue, value: unknown) {
  assertSchema(schema);
  if (!schemaMatches(schema, value)) fail(400, "AI_INVALID_INPUT");
}
