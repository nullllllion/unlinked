// Live check against Sepolia: the quote is real and the exact calldata the
// page sends would succeed. The sender is funded with a state override, so
// nothing is spent. Needs network access: `npm run test:live -w @unlinked/quiet-swap`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, parseEther } from "viem";
import { sepolia } from "viem/chains";
import { quoteArgs, quoterAbi, SEPOLIA, swapCalldata, withSlippage } from "../src/uniswap.ts";

const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA.rpc) });
const amountIn = parseEther("0.001");

test("the quoter prices 0.001 ETH in the ETH/USDC pool", async () => {
  const { result } = await client.simulateContract({ address: SEPOLIA.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: quoteArgs(amountIn) });
  assert.ok(result[0] > 0n, `amountOut ${result[0]}`);
});

test("the swap calldata executes against the Universal Router", async () => {
  const { result } = await client.simulateContract({ address: SEPOLIA.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: quoteArgs(amountIn) });
  const sender = "0x000000000000000000000000000000000000dEaD";
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await client.call({
    account: sender,
    to: SEPOLIA.universalRouter,
    data: swapCalldata(amountIn, withSlippage(result[0], 50n), deadline),
    value: amountIn,
    stateOverride: [{ address: sender, balance: parseEther("1") }],
  });
  // An impossible minimum must revert: proves the amounts are really enforced.
  await assert.rejects(
    client.call({
      account: sender,
      to: SEPOLIA.universalRouter,
      data: swapCalldata(amountIn, result[0] * 2n, deadline),
      value: amountIn,
      stateOverride: [{ address: sender, balance: parseEther("1") }],
    }),
  );
});
