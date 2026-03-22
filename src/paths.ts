import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

export const CONFIG_DIR = process.env.MAW_CONFIG_DIR || join(homedir(), ".config", "maw");
export const FLEET_DIR = join(CONFIG_DIR, "fleet");
export const CONFIG_FILE = join(CONFIG_DIR, "maw.config.json");

// Ensure dirs exist on first import
mkdirSync(FLEET_DIR, { recursive: true });
