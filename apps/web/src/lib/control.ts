export async function sendControl<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(result.error?.message ?? `Request failed (${response.status})`);
  return result;
}
