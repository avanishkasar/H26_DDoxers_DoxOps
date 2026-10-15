import type { RepoRef } from "./types.js";

/** First path segments on github.com that are GitHub features, not user or organisation names. */
const RESERVED_OWNERS = new Set([
  "about", "account", "apps", "blog", "codespaces", "collections", "contact", "copilot",
  "customer-stories", "dashboard", "discussions", "education", "enterprise", "events", "explore",
  "features", "git-guides", "github-copilot", "home", "issues", "join", "login", "logout",
  "marketplace", "mobile", "models", "new", "nonprofit", "notifications", "orgs", "organizations",
  "pricing", "pulls", "readme", "resources", "search", "security", "sessions", "settings", "signup",
  "site", "solutions", "sponsors", "stars", "team", "teams", "topics", "trending", "users", "watching",
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\-+@]{1,200}$/;

/**
 * Detect the repository a github.com URL points at.
 * Returns null for non-GitHub hosts, reserved paths (settings, orgs, marketplace ...) and profile pages.
 * The ref is taken from /tree/<ref> or /blob/<ref>/...; refs with slashes cannot be told apart from
 * paths, so callers fall back to the default branch when the ref does not resolve.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const parts = url.pathname.split("/").filter((p) => p.length > 0).map(safeDecode);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  let repo = parts[1]!;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;

  let ref: string | null = null;
  const kind = parts[2];
  if ((kind === "tree" || kind === "blob") && parts[3] !== undefined && REF_RE.test(parts[3])) {
    ref = parts[3];
  }
  return { owner, repo, ref };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function repoKey(r: { owner: string; repo: string; ref: string | null }): string {
  return `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}@${r.ref ?? "HEAD"}`;
}

export function cloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

/**
 * Deep link that makes VS Code clone and open the repository (handled by VS Code's built-in Git
 * extension). The DoxOps VS Code extension's Start panel then scans it or finds and fixes it.
 */
export function vscodeCloneLink(owner: string, repo: string): string {
  return `vscode://vscode.git/clone?url=${encodeURIComponent(cloneUrl(owner, repo) + ".git")}`;
}

export function cliCommand(owner: string, repo: string): string {
  return `doxops run ${cloneUrl(owner, repo)}`;
}
