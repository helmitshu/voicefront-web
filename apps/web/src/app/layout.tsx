import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { Providers } from './providers';

// Mirrors src/lib/theme.tsx (storage key + default). Inlined here because the
// root layout is a server component and the script must run before paint.
const THEME_INIT_SCRIPT = `(function(){var bg={'pearl':'#F4F1E9','midnight':'#060C11','deepteal':'#07231D'};try{var t=window.localStorage.getItem('vf-theme');if(!bg[t])t='midnight';document.documentElement.dataset.theme=t;document.documentElement.style.backgroundColor=bg[t];}catch(e){document.documentElement.dataset.theme='midnight';document.documentElement.style.backgroundColor=bg.midnight;}})();`;

export const metadata: Metadata = {
  title: { default: 'VoiceFront', template: '%s · VoiceFront' },
  description: 'Your AI receptionist, answering every call.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved app theme (default Midnight) to <html> before
            first paint so the signed-in app never flashes the wrong theme.
            Only `.theme-root` subtrees read the attribute, so marketing and
            auth pages are unaffected. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* The approved demo's typefaces: Sora (display) + Manrope (body).
            Used only inside `.theme-root` (globals.css scopes them); IBM Plex
            Mono stays self-hosted via @fontsource above. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
