// Which chain an RPC URL serves, guessed from its name.
//
// Failover needs the chain to pick an alternative provider. Normally it's
// learned from the endpoint's own eth_chainId answer, but an endpoint that
// refuses anonymous traffic from the first request never gives one. Provider
// URLs name their chain (eth-mainnet.g.alchemy.com, sepolia.infura.io,
// rpc.ankr.com/eth_sepolia…), so read it from there. When in doubt, return
// undefined: a wrong guess would answer from the wrong chain.

export function guessChainId(url: string): string | undefined {
  let name: string;
  try {
    const u = new URL(url);
    name = `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return undefined;
  }
  const l2 = /base|optimism|opt-|\bop-|arbitrum|\barb|polygon|matic|zksync|linea|scroll|blast|zora|unichain/.test(name);
  if (/goerli|holesky|hoodi|testnet|devnet/.test(name)) return undefined;
  if (name.includes("sepolia")) return l2 ? undefined : "0xaa36a7";
  if (/polygon|matic|zksync|linea|scroll|blast|zora|unichain/.test(name)) return undefined;
  if (/\bbase\b|base-mainnet|base-rpc/.test(name)) return "0x2105";
  if (/optimism|opt-mainnet/.test(name)) return "0xa";
  if (/arbitrum|arb-mainnet|\barb1\b/.test(name)) return "0xa4b1";
  if (/eth-mainnet|ethereum|mainnet\.infura|\beth\b|llamarpc|cloudflare-eth/.test(name)) return "0x1";
  return undefined;
}
