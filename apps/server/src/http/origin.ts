import type { FastifyRequest } from "fastify";

export function isSameOriginLocal(request: FastifyRequest, serverPort = Number(process.env.PORT ?? 3000)): boolean {
  if (!isAllowedLocalHost(request, serverPort)) return false;
  const origin = request.headers.origin;
  if (origin && !allowedLocalOrigin(origin, serverPort)) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite !== "cross-site";
}

export function isSameOriginMutation(request: FastifyRequest, serverPort = Number(process.env.PORT ?? 3000)): boolean {
  const origin = request.headers.origin;
  return isAllowedLocalHost(request, serverPort)
    && typeof origin === "string"
    && origin !== "null"
    && allowedLocalOrigin(origin, serverPort)
    && request.headers["sec-fetch-site"] !== "cross-site"
    && request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function isAllowedLocalHost(request: FastifyRequest, serverPort: number): boolean {
  const host = request.headers.host?.toLowerCase();
  return !!host && new Set([`127.0.0.1:${serverPort}`, `localhost:${serverPort}`, "127.0.0.1:5173", "localhost:5173"]).has(host);
}

function allowedLocalOrigin(origin: string, serverPort: number): boolean {
  return new Set([`http://127.0.0.1:${serverPort}`, `http://localhost:${serverPort}`, "http://127.0.0.1:5173", "http://localhost:5173"]).has(origin);
}
