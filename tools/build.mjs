import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const RUNTIME_FILES = Object.freeze(["module.json", "scripts/main.js", "scripts/data-model.js", "scripts/data-store.js", "lang/en.json", "lang/ru.json"]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP STORE, fixed 1980-01-01 timestamps; no platform tools or dependencies.
export function createZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function build({ root = ROOT, out = resolve(root, "dist") } = {}) {
  // Load and validate everything before touching the output directory.
  const entries = await Promise.all(RUNTIME_FILES.map(async path => [path, await readFile(resolve(root, path))]));
  const manifest = JSON.parse(entries[0][1].toString());
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (manifest.id !== "skybricate" || !/^\d+\.\d+\.\d+$/.test(manifest.version) || pkg.version !== manifest.version) {
    throw new Error("Invalid module ID or inconsistent release version");
  }
  const base = "https://github.com/gorohovDM/SkyBricate/releases";
  if (manifest.manifest !== `${base}/latest/download/module.json`
    || manifest.download !== `${base}/download/v${manifest.version}/skybricate.zip`) throw new Error("Invalid release URLs");
  for (const path of [...(manifest.esmodules ?? []), ...(manifest.styles ?? []), ...(manifest.languages ?? []).map(lang => lang.path)]) {
    if (!RUNTIME_FILES.includes(path)) throw new Error(`Manifest path is not packaged: ${path}`);
  }
  for (const [path, data] of entries) if (path.endsWith(".json")) JSON.parse(data.toString());
  for (const [path, data] of entries.filter(([path]) => path.endsWith(".js"))) {
    for (const match of data.toString().matchAll(/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      if (!match[1].startsWith(".") || !RUNTIME_FILES.includes(target)) throw new Error(`Import is not packaged: ${match[1]}`);
    }
  }
  const archive = createZip(entries);
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "skybricate.zip"), archive);
  await writeFile(resolve(out, "module.json"), entries[0][1]);
  return { archive, files: RUNTIME_FILES };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
  console.log(`Built dist/skybricate.zip and dist/module.json (${RUNTIME_FILES.length} runtime files).`);
}
