// A deliberately ordinary dapp: viem, its own public RPC over fetch, the
// wallet for signing. It has never heard of anon-rpc. That's the point:
// with Unlinked installed, every read below — balances, the quote that
// reveals what you're about to trade, the receipt polling — goes through an
// anonymity network anyway, split so the provider can't link accounts.

import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  formatUnits,
  http,
  parseEther,
  type Address,
  type EIP1193Provider,
} from "viem";
import { sepolia } from "viem/chains";
import { erc20Abi, quoteArgs, quoterAbi, SEPOLIA, swapCalldata, USDC, withSlippage } from "./uniswap.ts";

const SLIPPAGE_BPS = 50n; // 0.5%

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  connect: $<HTMLButtonElement>("connect"),
  amount: $<HTMLInputElement>("amount"),
  quote: $<HTMLOutputElement>("quote"),
  min: $("min"),
  swap: $<HTMLButtonElement>("swap"),
  status: $("status"),
  eth: $("eth-balance"),
  usdc: $("usdc-balance"),
  rpcHost: $("rpc-host"),
};
ui.rpcHost.textContent = new URL(SEPOLIA.rpc).host;

// batch: true sends concurrent reads as one JSON-RPC batch, the shape that
// links accounts at the provider unless something splits it.
const reads = createPublicClient({ chain: sepolia, transport: http(SEPOLIA.rpc, { batch: true }) });
const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

let account: Address | undefined;
let quoted: { amountIn: bigint; amountOut: bigint } | undefined;
let quoteSeq = 0;

function status(text: string, tone: "" | "ok" | "err" = "", link?: string): void {
  ui.status.className = `status ${tone}`;
  ui.status.replaceChildren(text);
  if (link) {
    const a = Object.assign(document.createElement("a"), { href: link, target: "_blank", rel: "noreferrer", textContent: "View on Etherscan ↗" });
    ui.status.append(" ", a);
  }
}

function parseAmount(): bigint | null {
  try {
    const v = parseEther(ui.amount.value.trim() || "0");
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

async function refreshBalances(): Promise<void> {
  if (!account) return;
  const [eth, usdc] = await Promise.all([
    reads.getBalance({ address: account }),
    reads.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  ui.eth.textContent = `Balance ${Number(formatEther(eth)).toFixed(4)}`;
  ui.usdc.textContent = `Balance ${Number(formatUnits(usdc, USDC.decimals)).toFixed(2)}`;
}

async function quote(): Promise<void> {
  const seq = ++quoteSeq;
  const amountIn = parseAmount();
  quoted = undefined;
  syncButton();
  if (!amountIn) {
    ui.quote.textContent = "–";
    ui.min.textContent = "";
    return;
  }
  ui.quote.textContent = "…";
  try {
    const { result } = await reads.simulateContract({ address: SEPOLIA.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: quoteArgs(amountIn) });
    if (seq !== quoteSeq) return; // a newer amount was typed meanwhile
    quoted = { amountIn, amountOut: result[0] };
    ui.quote.textContent = Number(formatUnits(result[0], USDC.decimals)).toFixed(2);
    ui.min.textContent = `At least ${Number(formatUnits(withSlippage(result[0], SLIPPAGE_BPS), USDC.decimals)).toFixed(2)} after 0.5% slippage`;
  } catch {
    if (seq !== quoteSeq) return;
    ui.quote.textContent = "–";
    ui.min.textContent = "No quote: not enough liquidity for this amount";
  }
  syncButton();
}

function syncButton(): void {
  ui.swap.disabled = !account || !quoted;
  ui.swap.textContent = !account ? "Connect a wallet to swap" : quoted ? "Swap" : "Enter an amount";
}

async function connect(): Promise<void> {
  if (!injected) return status("No wallet found. Install one to swap.", "err");
  const wallet = createWalletClient({ chain: sepolia, transport: custom(injected) });
  [account] = await wallet.requestAddresses();
  if ((await wallet.getChainId()) !== sepolia.id) await wallet.switchChain({ id: sepolia.id });
  ui.connect.textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
  ui.connect.disabled = true;
  syncButton();
  await refreshBalances();
}

async function swap(): Promise<void> {
  if (!account || !injected || !quoted) return;
  const wallet = createWalletClient({ account, chain: sepolia, transport: custom(injected) });
  const { amountIn, amountOut } = quoted;
  const data = swapCalldata(amountIn, withSlippage(amountOut, SLIPPAGE_BPS), BigInt(Math.floor(Date.now() / 1000) + 600));
  ui.swap.disabled = true;
  try {
    status("Checking the swap…");
    await reads.call({ account, to: SEPOLIA.universalRouter, data, value: amountIn });
    status("Confirm in your wallet…");
    const hash = await wallet.sendTransaction({ to: SEPOLIA.universalRouter, data, value: amountIn });
    status("Waiting for the block…", "", `${SEPOLIA.explorer}/tx/${hash}`);
    const receipt = await reads.waitForTransactionReceipt({ hash, pollingInterval: 4_000 });
    if (receipt.status !== "success") throw new Error("the swap reverted");
    status("Swapped.", "ok", `${SEPOLIA.explorer}/tx/${hash}`);
    await Promise.all([refreshBalances(), quote()]);
  } catch (err) {
    status(`Swap failed: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message}`, "err");
  } finally {
    syncButton();
  }
}

let debounce = 0;
ui.amount.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = window.setTimeout(quote, 350);
});
ui.connect.addEventListener("click", () => void connect().catch((e) => status((e as Error).message, "err")));
ui.swap.addEventListener("click", () => void swap());
void quote();
