import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebUser } from "./web-auth.js";

export const csrfCookieName = "luanniao_csrf";
export const csrfHeaderName = "x-csrf-token";

export type WebCapability =
  | "viewer:metadata"
  | "traffic:read-sensitive"
  | "traffic:replay"
  | "connectivity:manage"
  | "operator:mutate"
  | "admin:credential"
  | "admin:delete"
  | "admin:export";

const roleCapabilities: Record<WebUser["role"], ReadonlySet<WebCapability>> = {
  admin: new Set<WebCapability>([
    "viewer:metadata",
    "traffic:read-sensitive",
    "traffic:replay",
    "connectivity:manage",
    "operator:mutate",
    "admin:credential",
    "admin:delete",
    "admin:export"
  ]),
  analyst: new Set<WebCapability>([
    "viewer:metadata",
    "traffic:read-sensitive",
    "operator:mutate"
  ])
};

export class WebSecurityError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code:
      | "authorization_forbidden"
      | "runtime_access_forbidden"
      | "csrf_token_missing"
      | "csrf_token_invalid"
      | "cross_origin_forbidden"
  ) {
    super(message);
  }
}

export function hasCapability(user: WebUser, capability: WebCapability): boolean {
  return roleCapabilities[user.role].has(capability);
}

export function requireCapability(user: WebUser, capability: WebCapability): void {
  if (!hasCapability(user, capability)) {
    throw new WebSecurityError("当前角色无权执行此操作", 403, "authorization_forbidden");
  }
}

/**
 * Compatibility policy: runtime records do not currently carry an owner or ACL.
 * Object-level access is therefore bounded by the server RuntimePathPolicy root;
 * every authenticated user with the required capability may access that root.
 */
export function requireRuntimeAccess(user: WebUser, capability: WebCapability): void {
  requireCapability(user, capability);
}

export function createCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validateMutationRequest(request: IncomingMessage, csrfCookieToken: string | undefined): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return;

  const origin = singleHeader(request.headers.origin);
  if (origin && origin !== requestOrigin(request)) {
    throw new WebSecurityError("请求来源与服务器不一致", 403, "cross_origin_forbidden");
  }

  const headerToken = singleHeader(request.headers[csrfHeaderName]);
  if (!csrfCookieToken || !headerToken) {
    throw new WebSecurityError("缺少 CSRF token", 403, "csrf_token_missing");
  }
  if (!tokensEqual(csrfCookieToken, headerToken)) {
    throw new WebSecurityError("CSRF token 无效", 403, "csrf_token_invalid");
  }
}

export function csrfCookie(token: string, request: IncomingMessage): string {
  return `${csrfCookieName}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=604800${secureCookieSuffix(request)}`;
}

export function clearCsrfCookie(request: IncomingMessage): string {
  return `${csrfCookieName}=; Path=/; SameSite=Lax; Max-Age=0${secureCookieSuffix(request)}`;
}

function requestOrigin(request: IncomingMessage): string {
  const protocol = singleHeader(request.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  const host = request.headers.host;
  if (!host) throw new WebSecurityError("请求缺少 Host", 403, "cross_origin_forbidden");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new WebSecurityError("请求 Host 无效", 403, "cross_origin_forbidden");
  }
}

function secureCookieSuffix(request: IncomingMessage): string {
  return singleHeader(request.headers["x-forwarded-proto"]) === "https" ? "; Secure" : "";
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
