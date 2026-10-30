import { t } from "../../shared/i18n/index.ts";
import { fail } from "./types";
// Hono's body-limit stream no longer carries workerd's internal known-length marker.
export async function putStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options: R2PutOptions = {},
  length?: number,
  maximum = 26 * 1024 * 1024,
) {
  if (length !== undefined && length > maximum) fail(413, t("mailObjects.mailObjectIsTooLarge"));
  if (length !== undefined && Number.isSafeInteger(length) && length > 0) {
    const fixed = new FixedLengthStream(length);
    const results = await Promise.allSettled([
      stream.pipeTo(fixed.writable),
      bucket.put(key, fixed.readable, options),
    ]);
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    return (results[1] as PromiseFulfilledResult<R2Object | null>).value;
  }
  // Bound unknown-length input without relying on Content-Length supplied by a client.
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      fail(413, t("mailObjects.mailObjectIsTooLarge"));
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bucket.put(key, bytes, options);
}
