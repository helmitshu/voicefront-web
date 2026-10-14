'use client';

import { useEffect, useRef } from 'react';
import type { Industry } from '@/lib/api';

/**
 * Official "Continue with Google" button (Google Identity Services). Loads
 * Google's GSI client, renders their standard button, and hands the ID
 * token (`credential`) to the caller, which posts it to
 * POST /api/auth/google. Renders nothing — button and divider alike — when
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset, so the email form is untouched.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

interface GisCredentialResponse {
  credential?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: GisCredentialResponse) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

interface Props {
  /**
   * Called with the Google ID token after a successful Google sign-in. When
   * an industry is supplied, the value current at click time is included.
   */
  onCredential: (credential: string, industry?: Industry) => void;
  /** Currently selected signup industry, when the surrounding form has one. */
  industry?: Industry;
}

export function GoogleSignInButton({ onCredential, industry }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;
  const industryRef = useRef(industry);
  industryRef.current = industry;

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;

    function init() {
      if (cancelled || !window.google || !holderRef.current) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID as string,
        callback: (response) => {
          if (response.credential) callbackRef.current(response.credential, industryRef.current);
        },
      });
      const width = Math.min(400, Math.max(200, holderRef.current.clientWidth || 320));
      window.google.accounts.id.renderButton(holderRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width,
      });
    }

    if (window.google?.accounts?.id) {
      init();
      return () => {
        cancelled = true;
      };
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', init);
      return () => {
        cancelled = true;
        existing.removeEventListener('load', init);
      };
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', init);
    document.head.appendChild(script);
    return () => {
      cancelled = true;
      script.removeEventListener('load', init);
    };
  }, []);

  if (!CLIENT_ID) return null;

  return (
    <>
      <div ref={holderRef} className="mt-8 flex min-h-11 justify-center" />
      <div className="mt-6 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}
