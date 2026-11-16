import type { FastifyRequest } from "fastify";

export function isSameOriginLocal(request: FastifyRequest, serverPort = Number(process.env.PORT ?? 3000)): boolean {
  const host = request.headers.host?.toLowerCase();
  if (!host) return false;
  const allowedHosts = new Set([`127.0.0.1:${serverPort}`, `localhost:${serverPort}`, "127.0.0.1:5173", "localhost:5173"]);
  if (!allowedHosts.has(host)) return false;
  const origin = request.headers.origin;
  const allowedOrigins = new Set([`http://127.0.0.1:${serverPort}`, `http://localhost:${serverPort}`, "http://127.0.0.1:5173", "http://localhost:5173"]);
  if (origin && !allowedOrigins.has(origin)) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite !== "cross-site";
}
