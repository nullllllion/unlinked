// Uniswap v4 on Sepolia: an exact-input ETH → USDC swap through the Universal
// Router, quoted with V4Quoter. Pure functions; main.ts does the I/O.
//
// Addresses: developers.uniswap.org/contracts/v4/deployments (Sepolia).
// Quotes come from an on-chain eth_call to the quoter, not the Uniswap API,
// so there is no API key tying requests to anyone.

import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, zeroAddress, type Hex } from "viem";

export const SEPOLIA = {
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  quoter: "0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244",
  universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
} as const;

export const USDC = { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6 } as const;

/** Native ETH / USDC, 0.3%: the deepest of the Sepolia v4 ETH/USDC pools when this was written. */
export const POOL_KEY = {
  currency0: zeroAddress,
  currency1: USDC.address,
  fee: 3000,
  tickSpacing: 60,
  hooks: zeroAddress,
} as const;

export const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

// Universal Router command and v4-periphery Actions (libraries/Actions.sol).
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

/**
 * IV4Router.ExactInputSingleParams as compiled into the Sepolia Universal
 * Router listed above. v4-periphery main has since added `minHopPriceX36`;
 * routers built from it need that field too.
 */
const EXACT_INPUT_SINGLE = {
  type: "tuple",
  components: [
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

const currencyAmount = [{ type: "address" }, { type: "uint256" }] as const;

/** Calldata for UniversalRouter.execute: swap exactly `amountIn` ETH for at least `minOut` USDC. */
export function swapCalldata(amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const params = [
    encodeAbiParameters([EXACT_INPUT_SINGLE], [{ poolKey: POOL_KEY, zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters(currencyAmount, [POOL_KEY.currency0, amountIn]), // SETTLE_ALL: pay the ETH in
    encodeAbiParameters(currencyAmount, [POOL_KEY.currency1, minOut]), // TAKE_ALL: take the USDC out
  ];
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
  return encodeFunctionData({ abi: routerAbi, functionName: "execute", args: [encodePacked(["uint8"], [V4_SWAP]), [input], deadline] });
}

export function quoteArgs(amountIn: bigint) {
  return [{ poolKey: POOL_KEY, zeroForOne: true, exactAmount: amountIn, hookData: "0x" as Hex }] as const;
}

/** `amount` minus `bps` basis points. */
export const withSlippage = (amount: bigint, bps: bigint) => amount - (amount * bps) / 10_000n;
