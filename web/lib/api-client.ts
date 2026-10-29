export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: object | Blob;
  token?: string;
  retryAuth?: boolean;
  signal?: AbortSignal;
  response?: "json" | "blob" | "response";
  headers?: Record<string, string>;
}

export function createApiClient(deps: {
  accessToken: () => Promise<string>;
  refresh: () => Promise<unknown>;
  fetch: typeof fetch;
}) {
  return async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const binaryBody = options.body instanceof Blob;
    const send = (token: string) =>
      deps.fetch(path, {
        method: options.method ?? "GET",
        credentials: "omit",
        cache: "no-store",
        signal:
          options.signal && (!options.method || options.method === "GET")
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
            : (options.signal ?? AbortSignal.timeout(15_000)),
        headers: {
          ...(options.body
            ? {
                "Content-Type": binaryBody
                  ? (options.body as Blob).type || "application/octet-stream"
                  : "application/json",
              }
            : {}),
          ...Object.fromEntries(
            Object.entries(options.headers ?? {}).filter(
              ([name]) => name.toLowerCase() !== "authorization",
            ),
          ),
          Authorization: `Bearer ${token}`,
        },
        body: binaryBody
          ? (options.body as Blob)
          : options.body
            ? JSON.stringify(options.body)
            : undefined,
      });
    let response = await send(options.token ?? (await deps.accessToken()));
    if (response.status === 401 && !options.token && options.retryAuth !== false) {
      await deps.refresh();
      response = await send(await deps.accessToken());
    }
    if (!response.ok) {
      let message = "Unable to complete your request. Try again later.";
      try {
        const result = (await response.json()) as { error?: unknown };
        if (response.status < 500 && typeof result.error === "string") message = result.error;
      } catch {
        /* The HTTP status still identifies the failure. */
      }
      throw new ApiError(response.status, message);
    }
    return options.response === "response"
      ? (response as T)
      : response.status === 204
        ? (undefined as T)
        : options.response === "blob"
          ? ((await response.blob()) as T)
          : response.json();
  };
}
