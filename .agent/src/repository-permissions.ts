import { ghApi, ghApiOk } from "./github.js";

function normalizeLogin(value: string): string {
  return String(value || "").trim();
}

export function hasOrgMembership(orgLogin: string, userLogin: string): boolean {
  const org = normalizeLogin(orgLogin);
  const user = normalizeLogin(userLogin);
  if (!org || !user) return false;

  const membershipState = ghApi([
    `orgs/${org}/memberships/${user}`,
    "--jq",
    ".state // empty",
  ]).toLowerCase();
  if (membershipState === "active") {
    return true;
  }

  // Public membership endpoint returns 204 (empty body) on success, so use
  // ghApiOk rather than checking the body.
  return ghApiOk([`orgs/${org}/members/${user}`]);
}

export function hasRepositoryPermission(repository: string, userLogin: string): boolean {
  const repo = normalizeLogin(repository);
  const user = normalizeLogin(userLogin);
  if (!repo || !user) return false;

  const permission = ghApi([
    `repos/${repo}/collaborators/${user}/permission`,
    "--jq",
    ".permission // .role_name // empty",
  ]).toLowerCase();

  return Boolean(permission) && permission !== "none";
}

export function hasRepositoryCollaborator(repository: string, userLogin: string): boolean {
  const repo = normalizeLogin(repository);
  const user = normalizeLogin(userLogin);
  if (!repo || !user) return false;

  return ghApiOk([`repos/${repo}/collaborators/${user}`]);
}
