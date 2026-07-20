import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchCurrentUser, loginUser, logoutUser, registerUser } from "./api";
import type { AuthUser } from "./types";

export interface AuthState {
  user?: AuthUser;
  loading: boolean;
  submitting: boolean;
  error?: string;
  login: (input: { username: string; password: string }) => Promise<void>;
  register: (input: { username: string; displayName: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCurrentUser(controller.signal)
      .then((response) => setUser(response.user))
      .catch((requestError) => {
        if (!controller.signal.aborted && (!(requestError instanceof ApiError) || requestError.status !== 401)) {
          setError(errorText(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const login = useCallback(async (input: { username: string; password: string }) => {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await loginUser(input);
      setUser(response.user);
    } catch (requestError) {
      setError(errorText(requestError));
      throw requestError;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const register = useCallback(async (input: { username: string; displayName: string; password: string }) => {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await registerUser(input);
      setUser(response.user);
    } catch (requestError) {
      setError(errorText(requestError));
      throw requestError;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setSubmitting(true);
    try {
      await logoutUser();
    } finally {
      setUser(undefined);
      setSubmitting(false);
    }
  }, []);

  return { user, loading, submitting, error, login, register, logout, clearError: () => setError(undefined) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
