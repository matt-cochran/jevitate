export interface JsonEnvelope<T> {
  v: 1;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export function ok<T>(data: T): JsonEnvelope<T> {
  return { v: 1, ok: true, data };
}

export function fail(code: string, message: string): JsonEnvelope<never> {
  return { v: 1, ok: false, error: { code, message } };
}
