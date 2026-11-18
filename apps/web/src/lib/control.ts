export async function sendControl<T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  let result: { error?: { message?: string } } & T;
  try { result = await response.json() as typeof result; }
  catch { throw new Error(response.ok ? "Server returned an invalid response. Please retry." : `Request failed (${response.status}). Please retry.`); }
  if (!response.ok) throw new Error(result?.error?.message ?? `Request failed (${response.status})`);
  return result;
}
