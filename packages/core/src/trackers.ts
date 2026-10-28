// Third parties worth naming. Hand-curated for this project (MIT), and
// deliberately short: anything not listed still shows up as an unnamed third
// party, so the list only adds a label, never decides what is reported.

export type TrackerCategory =
  | "analytics"
  | "advertising"
  | "session replay"
  | "error monitoring"
  | "web3 attribution"
  | "wallet telemetry";

const TRACKERS: Readonly<Record<string, TrackerCategory>> = {
  // Analytics
  "google-analytics.com": "analytics",
  "googletagmanager.com": "analytics",
  "analytics.google.com": "analytics",
  "segment.io": "analytics",
  "segment.com": "analytics",
  "mixpanel.com": "analytics",
  "amplitude.com": "analytics",
  "heapanalytics.com": "analytics",
  "posthog.com": "analytics",
  "plausible.io": "analytics",
  "statsig.com": "analytics",
  "featuregates.org": "analytics",
  "clarity.ms": "session replay",
  "hotjar.com": "session replay",
  "hotjar.io": "session replay",
  "fullstory.com": "session replay",
  "logrocket.com": "session replay",
  "lr-ingest.io": "session replay",
  "lr-in.com": "session replay",
  // Advertising
  "doubleclick.net": "advertising",
  "googlesyndication.com": "advertising",
  "facebook.net": "advertising",
  "ads-twitter.com": "advertising",
  "analytics.tiktok.com": "advertising",
  "licdn.com": "advertising",
  "hypelab.com": "advertising",
  "slise.xyz": "advertising",
  // Error monitoring (sends URLs, often with addresses in them)
  "sentry.io": "error monitoring",
  "browser-intake-datadoghq.com": "error monitoring",
  "datadoghq-browser-agent.com": "error monitoring",
  "nr-data.net": "error monitoring",
  "bugsnag.com": "error monitoring",
  // Wallet-to-identity attribution
  "spindl.xyz": "web3 attribution",
  "cookie3.co": "web3 attribution",
  "addressable.io": "web3 attribution",
  "formo.so": "web3 attribution",
  // Wallet SDK telemetry
  "pulse.walletconnect.org": "wallet telemetry",
  "pulse.walletconnect.com": "wallet telemetry",
};

/** The category for a host or any parent domain of it, or null if unlisted. */
export function trackerCategory(host: string): TrackerCategory | null {
  const labels = host.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const hit = TRACKERS[labels.slice(i).join(".")];
    if (hit) return hit;
  }
  return null;
}
