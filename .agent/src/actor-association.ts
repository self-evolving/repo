import { ghApi, ghApiOk } from "./github.js";

export type ResolvedGithubActorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "NONE";

export interface ResolveGithubActorAssociationOptions {
  repo?: string;
  actorLogin: string;
  ownerLogin?: string;
  ownerType?: string;
  lookupOrder?: "organization-first" | "repository-first";
}

export function normalizeGithubActorLogin(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "");
}

export function resolveGithubActorAssociation(
  options: ResolveGithubActorAssociationOptions,
): ResolvedGithubActorAssociation {
  const repo = String(options.repo || "").trim();
  const actorLogin = String(options.actorLogin || "").trim();
  const [repoOwner = ""] = repo.split("/");
  const ownerLogin = String(options.ownerLogin || repoOwner).trim();
  const ownerType = String(options.ownerType || "").trim().toLowerCase();

  if (!actorLogin) return "NONE";

  const personalOwner = ownerType === "user" || !ownerType;
  if (
    personalOwner &&
    ownerLogin &&
    normalizeGithubActorLogin(actorLogin) === normalizeGithubActorLogin(ownerLogin)
  ) {
    return "OWNER";
  }

  const checks = options.lookupOrder === "repository-first"
    ? [resolveRepositoryPermissionAssociation, resolveOrgMembershipAssociation]
    : [resolveOrgMembershipAssociation, resolveRepositoryPermissionAssociation];

  for (const check of checks) {
    const association = check(repo, ownerLogin, actorLogin, ownerType);
    if (association !== "NONE") return association;
  }

  return "NONE";
}

export function hasGithubRepositoryCollaborator(repo: string, actorLogin: string): boolean {
  const repository = String(repo || "").trim();
  const login = escapePathPart(actorLogin);
  if (!repository || !login) return false;

  return ghApiOk([`repos/${repository}/collaborators/${login}`]);
}

export function hasGithubRepositoryPermission(repo: string, actorLogin: string): boolean {
  const repository = String(repo || "").trim();
  const login = escapePathPart(actorLogin);
  if (!repository || !login) return false;

  const permission = ghApi([
    `repos/${repository}/collaborators/${login}/permission`,
    "--jq",
    ".permission // .role_name // empty",
  ]).toLowerCase();

  return Boolean(permission) && permission !== "none";
}

export function hasGithubOrgMembership(orgLogin: string, actorLogin: string): boolean {
  const org = escapePathPart(orgLogin);
  const login = escapePathPart(actorLogin);
  if (!org || !login) return false;

  const membershipState = ghApi([
    `orgs/${org}/memberships/${login}`,
    "--jq",
    ".state // empty",
  ]).toLowerCase();
  if (membershipState === "active") return true;

  // Public membership endpoint returns 204 (empty body) on success, so use
  // ghApiOk rather than checking the body.
  return ghApiOk([`orgs/${org}/members/${login}`]);
}

function resolveOrgMembershipAssociation(
  _repo: string,
  ownerLogin: string,
  actorLogin: string,
  ownerType: string,
): ResolvedGithubActorAssociation {
  if (ownerType && ownerType !== "organization") return "NONE";
  return hasGithubOrgMembership(ownerLogin, actorLogin) ? "MEMBER" : "NONE";
}

function resolveRepositoryPermissionAssociation(
  repo: string,
  _ownerLogin: string,
  actorLogin: string,
): ResolvedGithubActorAssociation {
  return hasGithubRepositoryPermission(repo, actorLogin) ? "COLLABORATOR" : "NONE";
}

function escapePathPart(value: string): string {
  return encodeURIComponent(String(value || "").trim());
}
