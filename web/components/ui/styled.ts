import { createElement, type ElementType } from "react";

// Only add a styling hook. Base UI still owns rendering, state, events and refs.
// Keep the original call signature, including generic component props.
export function styledPart<T>(component: T, name: string): T {
  function StyledPart(props: Record<string, unknown>) {
    return createElement(component as ElementType, { "data-ui": name, ...props });
  }
  StyledPart.displayName = `UI(${name})`;
  return StyledPart as T;
}

export function styledParts<T extends object>(components: T, names: Partial<Record<keyof T, string>>): T {
  const result = { ...components };
  for (const key of Object.keys(names) as (keyof T)[]) {
    const name = names[key];
    if (name) result[key] = styledPart(components[key], name);
  }
  return result;
}
