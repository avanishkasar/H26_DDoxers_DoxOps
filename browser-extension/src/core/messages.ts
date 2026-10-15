import type { AnalysisResult } from "./types.js";

export interface AnalyzeRequest {
  type: "analyze";
  owner: string;
  repo: string;
  ref: string | null;
  /** Skip the per-repository result cache (the popup's "Rescan" button). */
  force?: boolean;
}

export type AnalyzeResponse = { ok: true; result: AnalysisResult } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\-+@/]{1,200}$/;

/** Validate an incoming runtime message; anything else is rejected. */
export function asAnalyzeRequest(msg: unknown): AnalyzeRequest | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m["type"] !== "analyze") return null;
  const { owner, repo, ref, force } = m;
  if (typeof owner !== "string" || !NAME_RE.test(owner)) return null;
  if (typeof repo !== "string" || !NAME_RE.test(repo)) return null;
  if (ref !== null && ref !== undefined && (typeof ref !== "string" || !REF_RE.test(ref) || ref.includes(".."))) return null;
  return { type: "analyze", owner, repo, ref: typeof ref === "string" ? ref : null, force: force === true };
}
