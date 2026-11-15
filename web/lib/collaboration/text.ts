import type { Text } from "yjs";

export function replaceSharedText(field: Text, value: string) {
  const old = field.toString();
  let start = 0,
    end = 0;
  while (start < old.length && start < value.length && old[start] === value[start]) start++;
  while (
    end < old.length - start &&
    end < value.length - start &&
    old[old.length - 1 - end] === value[value.length - 1 - end]
  )
    end++;
  field.doc!.transact(() => {
    field.delete(start, old.length - start - end);
    field.insert(start, value.slice(start, value.length - end));
  });
}
