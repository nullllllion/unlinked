import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeGroup,
  encodeGroup,
  groupByKey,
  isChainRead,
  parseJsonRpc,
  reassemble,
  type JsonRpcResponse,
  type PlannedCall,
} from "../src/jsonrpc.ts";

test("parseJsonRpc accepts single requests and batches, rejects everything else", () => {
  assert.deepEqual(parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}')?.batch, false);
  assert.equal(parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]')?.requests.length, 2);
  assert.equal(parseJsonRpc('{"query":"{ pools }"}'), null); // GraphQL
  assert.equal(parseJsonRpc("[]"), null);
  assert.equal(parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"a"},{"nope":1}]'), null);
  assert.equal(parseJsonRpc("not json, mentions \"jsonrpc\""), null);
});

test("groups get fresh wire ids, so groups never share an id sequence", () => {
  const calls: PlannedCall[] = [
    { index: 0, key: "A", request: { jsonrpc: "2.0", id: 41, method: "eth_getBalance", params: ["0xa", "latest"] } },
    { index: 1, key: "B", request: { jsonrpc: "2.0", id: 42, method: "eth_getBalance", params: ["0xb", "latest"] } },
    { index: 2, key: "A", request: { jsonrpc: "2.0", id: 43, method: "eth_blockNumber" } },
  ];
  const groups = groupByKey(calls);
  assert.deepEqual(groups.map((g) => g.key), ["A", "B"]);
  assert.deepEqual(groups[0].calls.map((c) => c.index), [0, 2]);

  let next = 1;
  const a = encodeGroup(groups[0], () => next++);
  const b = encodeGroup(groups[1], () => 1); // a different key's counter
  const wireA = JSON.parse(a.body);
  assert.ok(Array.isArray(wireA));
  assert.deepEqual(wireA.map((r: { id: number }) => r.id), [1, 2]);
  assert.equal(JSON.parse(b.body).id, 1, "a single call is sent unbatched");
  assert.ok(!("params" in wireA[1]), "absent params stay absent");
});

test("responses are mapped back by wire id and reassembled in the page's order", () => {
  const parsed = parseJsonRpc(
    '[{"jsonrpc":"2.0","id":"x","method":"a"},{"jsonrpc":"2.0","method":"notify"},{"jsonrpc":"2.0","id":7,"method":"b"}]',
  )!;
  const decoded = decodeGroup('[{"jsonrpc":"2.0","id":2,"result":"B"},{"jsonrpc":"2.0","id":"1","result":"A"}]', [1, 2]);
  const results: (JsonRpcResponse | undefined)[] = [decoded.get(1), undefined, decoded.get(2)];
  assert.deepEqual(JSON.parse(reassemble(parsed, results)), [
    { jsonrpc: "2.0", id: "x", result: "A" },
    { jsonrpc: "2.0", id: 7, result: "B" },
  ]);
});

test("a whole-body error applies to every call in the group", () => {
  const decoded = decodeGroup('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch too large"}}', [5, 6]);
  assert.equal(decoded.get(5)?.error?.message, "batch too large");
  assert.equal(decoded.get(6)?.error?.code, -32600);
});

test("isChainRead separates reads from wallet actions", () => {
  assert.equal(isChainRead("eth_getBalance"), true);
  assert.equal(isChainRead("eth_call"), true);
  assert.equal(isChainRead("eth_sendTransaction"), false);
  assert.equal(isChainRead("eth_requestAccounts"), false);
  assert.equal(isChainRead("personal_sign"), false);
});
