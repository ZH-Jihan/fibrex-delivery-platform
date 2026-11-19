/**
 * Auth state for the web app.
 *
 * Purpose: hold who is signed in (from the in-memory access token and the refresh cookie),
 * what they may do (`Access` from GET /me/permissions, checked with the shared `can()`),
 * and the sign-in steps: password, phone code, second step (authenticator or recovery
 * code), forced password change, forced authenticator set-up, sign-out, switch company.
 * Why permissions are read from the server: the API re-reads them on every request, so
 * the web copy only decides what to HIDE; the API is what refuses (SPEC 2.1).
 * Depends on: api/client, @fibrex/shared (can). Used by: App.tsx, shell, auth screens.
 */
import { can as canDo } from '@fibrex/shared/permissions';
import type { Access, ScopedRecord } from '@fibrex/shared/permissions';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from '../api/client';
import type { Grant } from '../api/client';

export type Status = 'loading' | 'anonymous' | 'authenticated';
/** What a first-factor sign-in led to. */
export type SignInStep = 'done' | 'mfa';

interface SignInResponse extends Partial<Grant> {
  mfaRequired?: true;
  mfaToken?: string;
}

export interface AuthApi {
  status: Status;
  grant: Grant | null;
  access: Access | null;
  /** True while a second step is pending (after a first factor that needs it). */
  mfaPending: boolean;
  can: (permission: string, record?: ScopedRecord) => boolean;
  login: (input: { tenant: string; identifier: string; password: string }) => Promise<SignInStep>;
  requestPhoneCode: (input: { tenant: string; phone: string }) => Promise<void>;
  verifyPhoneCode: (input: { tenant: string; phone: string; code: string }) => Promise<SignInStep>;
  verifyMfa: (code: string) => Promise<void>;
  cancelMfa: () => void;
  changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
  /** Called after authenticator set-up: the API returns a fresh access token. */
  adoptGrant: (grant: Grant) => Promise<void>;
  logout: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
  /** Re-read what the user may do (e.g. after publishing a record type adds `custom.<key>.*`). */
  refreshAccess: () => Promise<void>;
}

const Context = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [grant, setGrant] = useState<Grant | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  const loadAccess = useCallback(async (g: Grant) => {
    // A user who still owes a password change or authenticator set-up holds a token that
    // reaches only those routes; asking for permissions would be refused.
    if (g.user.mustChangePassword || g.mfaEnrolmentRequired) {
      setAccess(null);
      return;
    }
    try {
      setAccess(await api<Access>('/me/permissions'));
    } catch {
      setAccess(null);
    }
  }, []);

  const adoptGrant = useCallback(
    async (g: Grant) => {
      setAccessToken(g.accessToken);
      setGrant(g);
      setMfaToken(null);
      setStatus('authenticated');
      await loadAccess(g);
    },
    [loadAccess],
  );

  const clear = useCallback(() => {
    setAccessToken(null);
    setGrant(null);
    setAccess(null);
    setMfaToken(null);
    setStatus('anonymous');
  }, []);

  // On first load, try to continue an earlier session from the refresh cookie.
  useEffect(() => {
    const live = { cancelled: false };
    void (async () => {
      const g = await refreshSession();
      if (live.cancelled) return;
      if (g === null) setStatus('anonymous');
      else await adoptGrant(g);
    })();
    setSessionLostHandler(clear);
    return () => {
      live.cancelled = true;
      setSessionLostHandler(null);
    };
  }, [adoptGrant, clear]);

  const finishSignIn = useCallback(
    async (res: SignInResponse): Promise<SignInStep> => {
      if (res.mfaRequired === true && res.mfaToken !== undefined) {
        setMfaToken(res.mfaToken);
        return 'mfa';
      }
      await adoptGrant(res as Grant);
      return 'done';
    },
    [adoptGrant],
  );

  const value = useMemo<AuthApi>(
    () => ({
      status,
      grant,
      access,
      mfaPending: mfaToken !== null,
      can: (permission, record) => canDo(access, permission, record),
      login: async (input) =>
        finishSignIn(
          await api<SignInResponse>('/auth/login', { method: 'POST', body: input, auth: false }),
        ),
      requestPhoneCode: async (input) => {
        await api('/auth/otp/request', { method: 'POST', body: input, auth: false });
      },
      verifyPhoneCode: async (input) =>
        finishSignIn(
          await api<SignInResponse>('/auth/otp/verify', {
            method: 'POST',
            body: input,
            auth: false,
          }),
        ),
      verifyMfa: async (code) => {
        if (mfaToken === null) return;
        const res = await api<Grant>('/auth/mfa/verify', {
          method: 'POST',
          body: { mfaToken, code },
          auth: false,
        });
        await adoptGrant(res);
      },
      cancelMfa: () => {
        setMfaToken(null);
      },
      changePassword: async (input) => {
        await adoptGrant(
          await api<Grant>('/auth/password/change', { method: 'POST', body: input }),
        );
      },
      adoptGrant,
      logout: async () => {
        try {
          await api('/auth/logout', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfFromCookie() },
          });
        } finally {
          clear();
        }
      },
      switchCompany: async (companyId) => {
        await adoptGrant(
          await api<Grant>('/me/switch-company', { method: 'POST', body: { companyId } }),
        );
      },
      refreshAccess: async () => {
        if (grant !== null) await loadAccess(grant);
      },
    }),
    [status, grant, access, mfaToken, finishSignIn, adoptGrant, clear, loadAccess],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function csrfFromCookie(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'fibrex_csrf')
      return decodeURIComponent(part.slice(eq + 1));
  }
  return '';
}

export function useAuth(): AuthApi {
  const ctx = useContext(Context);
  if (ctx === null) throw new Error('useAuth needs an AuthProvider');
  return ctx;
}

/** Renders its children only when the user holds the permission (the API still enforces it). */
export function Can({
  permission,
  record,
  children,
}: {
  permission: string;
  record?: ScopedRecord;
  children: ReactNode;
}) {
  const { can } = useAuth();
  return can(permission, record) ? <>{children}</> : null;
}
