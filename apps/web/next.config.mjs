/** @type {import('next').NextConfig} */

// Security headers for every response the web app serves. The API already
// ships the helmet equivalent; the web app shipped none, which left pages
// frameable by other sites (clickjacking) and without HSTS. CSP is
// deliberately NOT set here: the app legitimately needs inline theme
// scripts, the Vapi demo SDK (mic, websockets, blob workers), Google
// Sign-In, and Turnstile frames, so a hand-rolled CSP risks breaking the
// demo. It lands as its own tested change.
const securityHeaders = [
  // Mirror the API's helmet HSTS so both surfaces make the same promise.
  { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
  // Only this site may frame its own pages.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The browser demo call needs the microphone on our own origin; camera
  // and geolocation are never used, so they are denied outright.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
];

const nextConfig = {
  reactStrictMode: true,
  // Stop advertising the framework in a response header.
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
