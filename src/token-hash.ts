// The at-rest form of every secret this server issues — the Apple Health
// shortcut link tokens and the claim/connect secrets around them — and how new
// ones are minted. Deliberately free of any database import, so a test double
// can apply the exact same contract the real store does.
import crypto from "node:crypto";

// Lowercase sha256 hex of the UTF-8 bytes. Stored hashes are compared by
// recomputing this, so the function must never change.
export function hashSecret(raw: string): string {
    return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// 32 random bytes, base64url: 43 characters, no padding. The raw value is
// handed to the client once and only hashSecret(raw) is ever stored.
export function newOpaqueToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}
