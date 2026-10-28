// A JSON-RPC proxy that shows what an RPC provider learns about its callers.
// Forwards to a real endpoint and prints, per request, the caller's IP and
// every address it asked about. Ctrl+C prints the linkage table: which
// addresses each IP revealed together.
//
// Without Unlinked: one IP, all your accounts, linked.
// With it: Tor exits, one identity per circuit, nothing to link.
//
//   UPSTREAM=https://ethereum-sepolia-rpc.publicnode.com PORT=8545 node server.mjs
//
// Put it behind TLS (e.g. Caddy) on a public host so Tor exits can reach it,
// set TRUST_PROXY=1 there, and point the dapp's RPC URL at it. BLOCK=1, or
// `kill -USR1 <pid>` at runtime, answers 403 to everything: the "this
// provider refuses Tor" moment that Unlinked's failover handles.

import { createServer } from "node:http";

const UPSTREAM = process.env.UPSTREAM ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PORT = Number(process.env.PORT ?? 8545);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
let blocked = process.env.BLOCK === "1";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
const PALETTE = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92, 94, 31];
const colorOf = new Map();
const linkage = new Map(); // ip -> Set<address>

const tint = (ip) => {
  if (!colorOf.has(ip)) colorOf.set(ip, PALETTE[colorOf.size % PALETTE.length]);
  return `\x1b[${colorOf.get(ip)}m${ip.padEnd(15)}\x1b[0m`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Addresses as `0x…` values or left-padded inside calldata. */
function addressesIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/0x([0-9a-fA-F]{40})(?![0-9a-fA-F])|0{24}([0-9a-fA-F]{40})/g)) {
    const hex = (m[1] ?? m[2]).toLowerCase();
    if (!/^0+$/.test(hex) && !/^0{30}/.test(hex)) found.add(`0x${hex}`);
  }
  return [...found];
}

process.on("SIGUSR1", () => {
  blocked = !blocked;
  console.log(`\x1b[1m-- refusing all callers: ${blocked ? "on" : "off"}\x1b[0m`);
});

process.on("SIGINT", () => {
  console.log("\n\x1b[1mWhat this provider can link (IP → addresses it asked about together)\x1b[0m");
  for (const [ip, addrs] of linkage) console.log(`  ${tint(ip)}  ${[...addrs].map(short).join(", ") || "(none)"}`);
  process.exit(0);
});

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  if (req.method !== "POST") return res.writeHead(405, CORS).end();

  const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
  let body = "";
  for await (const chunk of req) body += chunk;

  let methods = "?";
  try {
    const parsed = JSON.parse(body);
    methods = (Array.isArray(parsed) ? parsed : [parsed]).map((r) => r.method).join(",");
  } catch {
    // forwarded as-is
  }
  const addrs = addressesIn(body);
  if (!linkage.has(ip)) linkage.set(ip, new Set());
  for (const a of addrs) linkage.get(ip).add(a);
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time}  ${tint(ip)}  ${methods.padEnd(28)} ${addrs.map(short).join(" ")}${blocked ? "  \x1b[31m403\x1b[0m" : ""}`);

  if (blocked) return res.writeHead(403, CORS).end("refused");
  try {
    const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.writeHead(upstream.status, { ...CORS, "content-type": "application/json" }).end(await upstream.text());
  } catch (err) {
    res.writeHead(502, CORS).end(String(err));
  }
}).listen(PORT, () => console.log(`spy-rpc on :${PORT} → ${UPSTREAM}${blocked ? " (refusing all)" : ""}`));
