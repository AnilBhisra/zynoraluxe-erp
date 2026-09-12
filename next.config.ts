import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

// Headers that don't vary per request (no nonce involved) — the
// per-request Content-Security-Policy (which DOES need a fresh nonce
// every time) is set in src/proxy.ts instead, since next.config's
// headers() can't generate a new value per request. X-Frame-Options is
// kept alongside CSP's frame-ancestors for older browsers that don't
// support the CSP directive.
const STATIC_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
      "browsing-topics=(), interest-cohort=(), fullscreen=(self)",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Restricts who can EMBED our own responses cross-origin — does not
  // affect this app fetching/displaying Supabase-hosted signed images
  // (that's the opposite direction). Deliberately NOT setting
  // Cross-Origin-Embedder-Policy: that would require Supabase's own
  // responses to carry a matching CORP header, which we don't control,
  // and would break every signed image/PDF the app displays.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // HSTS only makes sense once the app is actually served over HTTPS —
  // enabling it in dev (plain http://localhost) has no effect but is
  // needless noise, so it's gated to production only.
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  // Minor fingerprinting hardening alongside the headers below — costs
  // nothing and isn't specific to any header requirement above.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: STATIC_SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
