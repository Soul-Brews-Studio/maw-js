import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadConfig, parseFlags } from "maw-js/sdk";

interface Contact {
  maw?: string;
  thread?: string;
  inbox?: string | null;
  repo?: string | null;
  notes?: string;
  retired?: boolean;
}

interface ContactsFile {
  contacts: Record<string, Contact>;
  updated: string;
}

function resolvePsiPath(): string {
  const config = loadConfig();
  if (config.psiPath) return config.psiPath;
  const cwd = process.cwd();
  if (existsSync(join(cwd, "ψ"))) return join(cwd, "ψ");
  return join(cwd, "psi");
}

function loadContacts(): ContactsFile {
  const path = join(resolvePsiPath(), "contacts.json");
  if (!existsSync(path)) return { contacts: {}, updated: new Date().toISOString() };
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveContacts(data: ContactsFile) {
  const psi = resolvePsiPath();
  mkdirSync(psi, { recursive: true });
  data.updated = new Date().toISOString();
  writeFileSync(join(psi, "contacts.json"), JSON.stringify(data, null, 2) + "\n");
}

export async function cmdContactsLs() {
  const { contacts } = loadContacts();
  const active = Object.entries(contacts).filter(([, c]) => !c.retired);
  if (!active.length) { console.log("\x1b[90mno contacts\x1b[0m"); return; }
  console.log(`\n\x1b[36mCONTACTS\x1b[0m (${active.length}):\n`);
  for (const [name, c] of active) {
    const maw = c.maw ? `maw: \x1b[33m${c.maw}\x1b[0m` : "";
    const thread = c.thread ? `thread: \x1b[90m${c.thread}\x1b[0m` : "";
    const inbox = c.inbox ? `inbox: \x1b[90m${c.inbox}\x1b[0m` : "";
    const repo = c.repo ? `repo: \x1b[90m${c.repo}\x1b[0m` : "";
    const notes = c.notes ? `\x1b[90m"${c.notes}"\x1b[0m` : "";
    const parts = [maw, thread, inbox, repo, notes].filter(Boolean).join("    ");
    console.log(`  \x1b[32m${name.padEnd(12)}\x1b[0m  ${parts}`);
  }
  console.log();
}

export async function cmdContactsAdd(name: string, args: string[]) {
  const data = loadContacts();
  const c: Contact = data.contacts[name] || {};
  const flags = parseFlags(args, {
    "--maw": String,
    "--thread": String,
    "--inbox": String,
    "--repo": String,
    "--notes": String,
  }, 0);
  if (flags["--maw"]) c.maw = flags["--maw"];
  if (flags["--thread"]) c.thread = flags["--thread"];
  if (flags["--inbox"]) c.inbox = flags["--inbox"];
  if (flags["--repo"]) c.repo = flags["--repo"];
  if (flags["--notes"]) c.notes = flags["--notes"];
  if (c.retired) delete c.retired;
  data.contacts[name] = c;
  saveContacts(data);
  console.log(`\x1b[32m✓\x1b[0m contact \x1b[33m${name}\x1b[0m saved`);
}

export async function cmdContactsRm(name: string) {
  const data = loadContacts();
  if (!data.contacts[name]) { console.error(`\x1b[31merror\x1b[0m: contact '${name}' not found`); return; }
  data.contacts[name].retired = true;
  saveContacts(data);
  console.log(`\x1b[32m✓\x1b[0m contact \x1b[33m${name}\x1b[0m retired`);
}
