'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ApiError,
  AuthApi,
  setToken,
  getToken,
  UNAUTHORIZED_EVENT,
  type Industry,
  type Me,
  type OnboardingView,
} from '@/lib/api';
import { FullScreenLoader } from '@/components/ui/Spinner';

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  login: (input: { email: string; password: string }) => Promise<Me>;
  register: (input: {
    companyName: string;
    industry: Industry;
    fullName: string;
    email: string;
    password: string;
  }) => Promise<Me>;
  signOut: () => void;
  refreshMe: () => Promise<void>;
  /** Locally apply a fresh onboarding view (returned by step endpoints). */
  setOnboarding: (view: OnboardingView) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();
  // Avoids state updates from a stale bootstrap racing a fresh login.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!getToken()) {
      setStatus('unauthenticated');
      return;
    }
    const controller = new AbortController();
    AuthApi.me(controller.signal)
      .then((data) => {
        if (generation.current !== gen) return;
        setMe(data);
        setStatus('authenticated');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (generation.current !== gen) return;
        if (err instanceof ApiError && err.status !== 401) {
          // Server unreachable or 5xx: don't silently drop the session token;
          // surface as signed-out for now without clearing it.
          setStatus('unauthenticated');
          return;
        }
        setToken(null);
        setMe(null);
        setStatus('unauthenticated');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      generation.current += 1;
      setMe(null);
      setStatus('unauthenticated');
      router.replace('/login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [router]);

  const login = useCallback(async (input: { email: string; password: string }) => {
    const data = await AuthApi.login(input);
    generation.current += 1;
    setToken(data.token);
    const nextMe: Me = { user: data.user, tenant: data.tenant, onboarding: data.onboarding };
    setMe(nextMe);
    setStatus('authenticated');
    return nextMe;
  }, []);

  const register = useCallback(
    async (input: {
      companyName: string;
      industry: Industry;
      fullName: string;
      email: string;
      password: string;
    }) => {
      const data = await AuthApi.register(input);
      generation.current += 1;
      setToken(data.token);
      const nextMe: Me = { user: data.user, tenant: data.tenant, onboarding: data.onboarding };
      setMe(nextMe);
      setStatus('authenticated');
      return nextMe;
    },
    [],
  );

  const signOut = useCallback(() => {
    generation.current += 1;
    setToken(null);
    setMe(null);
    setStatus('unauthenticated');
    router.replace('/login');
  }, [router]);

  const refreshMe = useCallback(async () => {
    const data = await AuthApi.me();
    setMe(data);
    setStatus('authenticated');
  }, []);

  const setOnboarding = useCallback((view: OnboardingView) => {
    setMe((current) => (current ? { ...current, onboarding: view } : current));
  }, []);

  const value = useMemo(
    () => ({ status, me, login, register, signOut, refreshMe, setOnboarding }),
    [status, me, login, register, signOut, refreshMe, setOnboarding],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Route guard for authenticated areas. Children render only once the session
 * is confirmed AND the user is in the right area for their onboarding state,
 * so there is never a flash of the wrong screen.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const inOnboarding = pathname.startsWith('/onboarding');
  const needsOnboarding = me ? !me.onboarding.isActive : false;

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
      return;
    }
    if (status !== 'authenticated' || !me) return;
    if (needsOnboarding && !inOnboarding) router.replace('/onboarding');
    if (!needsOnboarding && inOnboarding) router.replace('/dashboard');
  }, [status, me, needsOnboarding, inOnboarding, router]);

  if (status !== 'authenticated' || !me) return <FullScreenLoader />;
  if (needsOnboarding !== inOnboarding) return <FullScreenLoader />;
  return <>{children}</>;
}

/** Redirects signed-in users away from the auth pages. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated' && me) {
      router.replace(me.onboarding.isActive ? '/dashboard' : '/onboarding');
    }
  }, [status, me, router]);

  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <FullScreenLoader />;
  return <>{children}</>;
}
