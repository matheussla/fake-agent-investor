import { sendControl } from "./control.js";

export async function runOnce(simulationId: string) {
  if (!simulationId) throw new Error("Load the active simulation before running a decision.");
  const storageKey = `paper-investor:run-once:${simulationId}`;
  const requestId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
  // Persist before sending: a lost response must remain retryable after reload or navigation.
  sessionStorage.setItem(storageKey, requestId);
  const result = await sendControl<{ requestId: string; status: string }>("/api/agent/run-once", "POST", { requestId });
  if (result?.requestId !== requestId) throw new Error("Server did not confirm this decision request. Please retry.");
  if (sessionStorage.getItem(storageKey) === requestId) sessionStorage.removeItem(storageKey);
  return result;
}
