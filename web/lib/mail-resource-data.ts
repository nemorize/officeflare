/** Apply a confirmed read receipt without replacing a newer server version. */
export function applyReadReceipt(data: unknown, id: string, version: number): unknown {
  if (!data || typeof data !== "object") return data;
  const mark = (value: unknown) => {
    if (!value || typeof value !== "object") return value;
    const entry = value as { id?: string; version?: number };
    return entry.id === id && (entry.version ?? 0) <= version ? { ...entry, is_read: 1, version } : value;
  };
  const result = data as { message?: unknown; messages?: unknown[] };
  if (result.message) return { ...result, message: mark(result.message) };
  if (Array.isArray(result.messages)) return { ...result, messages: result.messages.map(mark) };
  return data;
}
