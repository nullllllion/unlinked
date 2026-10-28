// Read a build — a directory or a .zip — into a manifest of file hashes.
// The attester and the verifier both use this, so they can't disagree about
// what a build is.

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { hashableBytes, isStoreMetadata, manifestRoot, sha256Hex } from "../../core/src/manifest.ts";

export type Build = { files: Record<string, string>; root: string };

export async function readBuild(path: string): Promise<Build> {
  const entries = (await stat(path)).isDirectory() ? await readDir(path) : readZip(await readFile(path));
  const files: Record<string, string> = {};
  for (const [name, bytes] of entries) {
    if (isStoreMetadata(name)) continue;
    files[name] = await sha256Hex(hashableBytes(name, bytes));
  }
  return { files, root: await manifestRoot(files) };
}

async function readDir(dir: string): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = resolve(e.parentPath, e.name);
    out.push([relative(dir, full).split(sep).join("/"), await readFile(full)]);
  }
  return out;
}

/** Enough of ZIP to read stored and deflated entries via the central directory. */
function readZip(buf: Buffer): [string, Uint8Array][] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: [string, Uint8Array][] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    if (method === 0) out.push([name, data]);
    else if (method === 8) out.push([name, inflateRawSync(data)]);
    else throw new Error(`unsupported zip compression ${method} for ${name}`);
  }
  return out;
}
