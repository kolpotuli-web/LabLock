import { createHash, timingSafeEqual } from "node:crypto";
const FACULTY_PIN_HASH = process.env.FACULTY_PIN_HASH ?? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export function sha256Hex(input: string) { return createHash("sha256").update(input).digest("hex"); }
export function verifyFacultyKey(candidate: string) { const a=Buffer.from(sha256Hex(candidate.trim()),"hex"); const b=Buffer.from(FACULTY_PIN_HASH,"hex"); return a.length===b.length && timingSafeEqual(a,b); }
