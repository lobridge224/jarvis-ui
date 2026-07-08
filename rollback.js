// Deliberately dependency-free: this must work even if the running app is
// completely broken. Don't import express, dotenv, or anything from server.js.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.join(__dirname, "backups");
const PUBLIC_DIR = path.join(__dirname, "public");

async function listBackups() {
  try {
    const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch {
    return [];
  }
}

async function restore(stamp) {
  const src = path.join(BACKUPS_DIR, stamp, "public");
  const files = await fs.readdir(src);
  for (const f of files) {
    await fs.copyFile(path.join(src, f), path.join(PUBLIC_DIR, f));
  }
}

const arg = process.argv[2];
const backups = await listBackups();

if (backups.length === 0) {
  console.log("No backups found yet — nothing to roll back to. Backups are created automatically the first time you approve a UI change.");
  process.exit(0);
}

if (arg === "--list") {
  console.log("Available backups, newest first:");
  for (const b of backups) console.log(" -", b);
  process.exit(0);
}

const target = arg || backups[0];
if (!backups.includes(target)) {
  console.log(`No backup named "${target}". Run "npm run rollback:list" to see what's available.`);
  process.exit(1);
}

await restore(target);
console.log(`Restored public/ from backup: ${target}`);
console.log("If Jarvis is running, just refresh your browser — no restart needed for UI files.");
