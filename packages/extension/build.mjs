// Builds the extension reproducibly:
//
//   dist/unpacked/              chrome://extensions → Load unpacked
//   dist/unlinked-<version>.zip byte-identical across machines for the same commit
//
// Reproducibility is the point, not a nicety: Unlinked attests its own build
// on Arkiv, and anyone can rebuild this commit and compare. So: no timestamps,
// sorted zip entries, generated icons, and esbuild (deterministic for a given
// lockfile).

import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const OUT = resolve(HERE, "dist");
const UNPACKED = resolve(OUT, "unpacked");

await rm(OUT, { recursive: true, force: true });
await mkdir(resolve(UNPACKED, "icons"), { recursive: true });

// The harness's packaged offscreen + sandbox pages, version-stamped directory and all.
const harness = resolve(dirname(require.resolve("@anon-rpc/browser-extension-harness/package.json")), "dist/static/anon-rpc");
await cp(harness, resolve(UNPACKED, "anon-rpc"), { recursive: true });

// absWorkingDir pins the module-path comments esbuild writes into bundles.
// Without it they're relative to wherever the build was started, so the same
// commit built from another directory produced a different zip.
const common = {
  bundle: true,
  platform: "browser",
  target: "chrome116",
  legalComments: "none",
  logLevel: "warning",
  charset: "utf8",
  absWorkingDir: HERE,
};
await Promise.all([
  build({ ...common, format: "esm", entryPoints: [resolve(HERE, "src/background/index.ts")], outfile: resolve(UNPACKED, "background.js") }),
  build({ ...common, format: "iife", entryPoints: [resolve(HERE, "src/main-world.ts")], outfile: resolve(UNPACKED, "main-world.js") }),
  build({ ...common, format: "iife", entryPoints: [resolve(HERE, "src/content.ts")], outfile: resolve(UNPACKED, "content.js") }),
  build({ ...common, format: "iife", entryPoints: [resolve(HERE, "src/ui/popup.ts")], outfile: resolve(UNPACKED, "popup.js") }),
]);
await writeFile(resolve(UNPACKED, "popup.html"), await readFile(resolve(HERE, "src/ui/popup.html")));
for (const size of [16, 32, 48, 128]) await writeFile(resolve(UNPACKED, `icons/${size}.png`), icon(size));

// Manifest: version from package.json, `//` explanation keys stripped.
const pkg = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
const strip = (v) =>
  Array.isArray(v) ? v.map(strip)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("//")).map(([k, x]) => [k, strip(x)]))
  : v;
const manifest = { ...strip(JSON.parse(await readFile(resolve(HERE, "manifest.json"), "utf8"))), version: pkg.version };
await writeFile(resolve(UNPACKED, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const files = (await filesUnder(UNPACKED)).sort();
const zipName = `unlinked-${pkg.version}.zip`;
await writeFile(resolve(OUT, zipName), zip(await Promise.all(files.map(async (name) => ({ name, data: await readFile(resolve(UNPACKED, name)) })))));
console.log(`built dist/unpacked (${files.length} files) and dist/${zipName}`);

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.push(relative(dir, resolve(e.parentPath, e.name)).split(sep).join("/"));
  }
  return out;
}

/** A minimal deterministic ZIP: deflate, fixed 1980-01-01 timestamps, no extra fields. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time 00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** The mark — a ring with its left half filled — rasterised with 4×4 supersampling. */
function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2;
  const outer = size * 0.44;
  const inner = outer - Math.max(1.25, size * 0.1);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4 - c;
          const py = y + (sy + 0.5) / 4 - c;
          const d = Math.hypot(px, py);
          if (d <= outer && (d >= inner || px < 0)) hits++;
        }
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = 0x24;
      raw[i + 1] = 0x29;
      raw[i + 2] = 0x2f;
      raw[i + 3] = Math.round((hits / 16) * 255);
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
