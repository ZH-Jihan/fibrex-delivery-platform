/**
 * API client: the one place the web app talks to the server.
 *
 * Purpose: send JSON requests to /api/v1 with the access token (kept in memory only, never
 * in storage), add an Idempotency-Key to every write outside /auth (the API requires it),
 * turn RFC 9457 problem responses into `ApiError`, and renew an expired access token once
 * through the refresh cookie (double-submit CSRF: the readable `fibrex_csrf` cookie is
 * copied into the `X-CSRF-Token` header). Concurrent 401s share one refresh call.
 * Depends on: the browser fetch API. Used by: auth/AuthContext.tsx and every screen.
 */

const BASE = '/api/v1';
const CSRF_COOKIE = 'fibrex_csrf';

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  [extra: string]: unknown;
}

/** A failed API call. `code` is the stable problem code used to pick the translated text. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;

  constructor(status: number, code: string, message: string, problem: Problem) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
}

/** What `/auth/refresh` and the sign-in routes return once a session exists. */
export interface Grant {
  accessToken: string;
  expiresIn: number;
  user: {
    id: string;
    username: string;
    displayName: string;
    preferredLanguage: string;
    mustChangePassword: boolean;
  };
  companyId: string | null;
  roles: string[];
  mfaEnrolmentRequired: boolean;
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let refreshing: Promise<Grant | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
/** Called when a refresh is refused, so the app can go back to the sign-in page. */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

function readCookie(name: string): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return '';
}

async function toError(res: Response): Promise<ApiError> {
  let problem: Problem = {};
  try {
    problem = (await res.json()) as Problem;
  } catch {
    // The body was not JSON (a proxy error page, for example); the status is all we have.
  }
  const code = problem.code ?? `http_${String(res.status)}`;
  return new ApiError(res.status, code, problem.detail ?? problem.title ?? res.statusText, problem);
}

/** Renews the access token from the refresh cookie. Returns null when the session is gone. */
export function refreshSession(): Promise<Grant | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': readCookie(CSRF_COOKIE) },
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const grant = (await res.json()) as Grant;
      accessToken = grant.accessToken;
      return grant;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers, for example If-Match. */
  headers?: Record<string, string>;
  /** Send the access token (default). Sign-in calls turn this off. */
  auth?: boolean;
  /** Use this token instead of the stored one (the short MFA set-up token). */
  token?: string;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${BASE}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;

  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    // Every write outside /auth needs an idempotency key (SPEC 2.11).
    if (method !== 'GET' && !path.startsWith('/auth/')) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
    const token = options.token ?? accessToken;
    if (options.auth !== false && token !== null) headers.Authorization = `Bearer ${token}`;
    return fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };

  let res = await send();
  if (res.status === 401 && options.auth !== false && options.token === undefined) {
    if ((await refreshSession()) !== null) {
      res = await send();
    } else {
      onSessionLost?.();
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
