// "Site" in the browser sense: the registrable domain a request belongs to.
//
// The real answer needs the Public Suffix List (~200 KB). This keeps the
// suffixes that matter for dapps — hosting platforms and IPFS/ENS gateways,
// where every project is its own site under a shared suffix — and falls back
// to the last two labels. Getting it wrong only mislabels first vs third party.

const SUFFIXES_3: ReadonlySet<string> = new Set([
  "ipfs.dweb.link",
  "ipns.dweb.link",
  "ipfs.w3s.link",
  "ipfs.cf-ipfs.com",
]);

const SUFFIXES_2: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "co.in", "co.nz", "co.za", "co.kr",
  "com.br", "com.cn", "com.sg", "com.tr", "com.mx", "com.hk",
  "eth.limo", "eth.link", "bzz.link",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "herokuapp.com", "onrender.com", "fly.dev", "replit.app",
  "fleek.co", "on-fleek.app",
]);

export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.split(".");
  if (labels.length >= 4 && SUFFIXES_3.has(labels.slice(-3).join("."))) return labels.slice(-4).join(".");
  if (labels.length >= 3 && SUFFIXES_2.has(labels.slice(-2).join("."))) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:"
      ? u.hostname
      : null;
  } catch {
    return null;
  }
}

export function isThirdParty(host: string, topSite: string): boolean {
  return siteOf(host) !== topSite;
}
