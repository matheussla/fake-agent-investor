import type { FastifyRequest } from "fastify";

const allowedHosts = new Set(["127.0.0.1:3000", "127.0.0.1:5173", "localhost:3000", "localhost:5173"]);

export function isSameOriginLocal(request: FastifyRequest): boolean {
  const host = request.headers.host?.toLowerCase();
  if (!host || !allowedHosts.has(host)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite !== "cross-site";
}
