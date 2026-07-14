import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  RELEASE_MANIFEST_FILE,
  RELEASE_ROOT_DIRECTORY,
  hashReleaseFiles,
  normalizeReleasePath,
  sha256File,
  verifyReleaseRoot
} from "./release-contract.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(projectRoot, RELEASE_ROOT_DIRECTORY);
const outputRoot = path.dirname(releaseRoot);
const TAR_BLOCK = 512;

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("Release archive path is too long.");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error("Release archive numeric field overflowed.");
  writeString(buffer, offset, length, `${encoded}\0`);
}

function splitTarPath(relative) {
  const bytes = Buffer.byteLength(relative);
  if (bytes <= 100) return { name: relative, prefix: "" };
  const segments = relative.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Release archive path cannot be represented safely: ${relative}`);
}

function tarHeader(relative, size, sourceDateEpoch) {
  const { name, prefix } = splitTarPath(relative);
  const header = Buffer.alloc(TAR_BLOCK, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 8, `${encoded}\0 `);
  return header;
}

async function* tarStream(files, sourceDateEpoch) {
  for (const file of files) {
    yield tarHeader(file.path, file.size, sourceDateEpoch);
    for await (const chunk of createReadStream(path.join(releaseRoot, file.path))) yield chunk;
    const padding = (TAR_BLOCK - (file.size % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(TAR_BLOCK * 2);
}

function octalField(buffer, start, length) {
  const value = buffer.subarray(start, start + length).toString("ascii").replace(/[\0 ]+$/g, "");
  if (!/^[0-7]+$/.test(value)) throw new Error("Release archive numeric field is invalid.");
  return Number.parseInt(value, 8);
}

function archivePath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
  return normalizeReleasePath(prefix ? `${prefix}/${name}` : name);
}

function verifyHeaderChecksum(header) {
  const expected = octalField(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw new Error("Release archive header checksum mismatch.");
}

async function verifyArchive(archive, expectedRecords) {
  const expected = new Map(expectedRecords.map((record) => [record.path, record]));
  const seen = new Set();
  let buffer = Buffer.alloc(0);
  let current = null;
  let padding = 0;
  let terminalBlocks = 0;
  const stream = createReadStream(archive).pipe(createGunzip());
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (current) {
        if (current.remaining > 0) {
          if (buffer.length === 0) break;
          const consumed = Math.min(buffer.length, current.remaining);
          current.hash.update(buffer.subarray(0, consumed));
          buffer = buffer.subarray(consumed);
          current.remaining -= consumed;
          if (current.remaining > 0) break;
          const record = expected.get(current.path);
          if (!record || record.sha256 !== current.hash.digest("hex")) {
            throw new Error(`Release archive payload mismatch: ${current.path}`);
          }
          seen.add(current.path);
          padding = (TAR_BLOCK - (current.size % TAR_BLOCK)) % TAR_BLOCK;
          current = null;
        }
      }
      if (padding > 0) {
        if (buffer.length < padding) break;
        if (!buffer.subarray(0, padding).equals(Buffer.alloc(padding))) {
          throw new Error("Release archive padding is invalid.");
        }
        buffer = buffer.subarray(padding);
        padding = 0;
      }
      if (buffer.length < TAR_BLOCK) break;
      const header = buffer.subarray(0, TAR_BLOCK);
      buffer = buffer.subarray(TAR_BLOCK);
      if (header.equals(Buffer.alloc(TAR_BLOCK))) {
        terminalBlocks += 1;
        if (terminalBlocks === 2) break;
        continue;
      }
      if (terminalBlocks > 0) throw new Error("Release archive terminator is invalid.");
      verifyHeaderChecksum(header);
      if (header[156] !== "0".charCodeAt(0) && header[156] !== 0) {
        throw new Error("Release archive contains unsupported entry types.");
      }
      const relative = archivePath(header);
      if (seen.has(relative) || !expected.has(relative)) throw new Error(`Unexpected archive entry: ${relative}`);
      const size = octalField(header, 124, 12);
      if (size !== expected.get(relative).size) throw new Error(`Release archive size mismatch: ${relative}`);
      current = { path: relative, size, remaining: size, hash: createHash("sha256") };
      if (size === 0) {
        if (expected.get(relative).sha256 !== current.hash.digest("hex")) throw new Error(`Release archive payload mismatch: ${relative}`);
        seen.add(relative);
        current = null;
      }
    }
  }
  if (current || padding || terminalBlocks !== 2 || buffer.length !== 0 || seen.size !== expected.size) {
    throw new Error("Release archive is incomplete.");
  }
}

async function main() {
  const { manifest } = await verifyReleaseRoot(releaseRoot, { builderRoot: projectRoot });
  const version = manifest.application.version;
  const shortCommit = manifest.build.gitCommit.slice(0, 12);
  const basename = `videosave-${version}-${shortCommit}`;
  const archive = path.join(outputRoot, `${basename}.tar.gz`);
  const checksumFile = `${archive}.sha256`;
  const temporaryArchive = `${archive}.tmp-${process.pid}`;
  const temporaryChecksum = `${checksumFile}.tmp-${process.pid}`;
  const records = await hashReleaseFiles(releaseRoot);
  await Promise.all([
    rm(temporaryArchive, { force: true }),
    rm(temporaryChecksum, { force: true })
  ]);
  try {
    await pipeline(
      Readable.from(tarStream(records, manifest.build.sourceDateEpoch)),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(temporaryArchive, { flags: "wx", mode: 0o644 })
    );
    await verifyArchive(temporaryArchive, records);
    const checksum = await sha256File(temporaryArchive);
    await writeFile(temporaryChecksum, `${checksum}  ${path.basename(archive)}\n`, { mode: 0o644, flag: "wx" });
    const parsedManifest = JSON.parse(await readFile(path.join(releaseRoot, RELEASE_MANIFEST_FILE), "utf8"));
    if (parsedManifest.build.gitCommit !== manifest.build.gitCommit) {
      throw new Error("Release manifest changed during packaging.");
    }
    await rename(temporaryArchive, archive);
    await rename(temporaryChecksum, checksumFile);
  } finally {
    await Promise.all([
      rm(temporaryArchive, { force: true }),
      rm(temporaryChecksum, { force: true })
    ]);
  }
  console.info(`Release archive passed verification: ${path.basename(archive)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Release packaging failed.");
  process.exitCode = 1;
});
