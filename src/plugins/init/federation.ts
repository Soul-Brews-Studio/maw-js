import { randomBytes } from "crypto";

export function generateFederationToken(): string {
  return randomBytes(32).toString("hex");
}

export function isValidFederationToken(t: string): boolean {
  return typeof t === "string" && t.length >= 16;
}
