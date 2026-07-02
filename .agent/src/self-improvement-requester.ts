export interface SelfImprovementRequesterInput {
  eventName: string;
  actor: string;
  repository: string;
  repositoryOwner: string;
  repositoryOwnerType: string;
}

export interface SelfImprovementRequesterLookup {
  hasOrgMembership(orgLogin: string, userLogin: string): boolean;
  hasRepositoryPermission(repository: string, userLogin: string): boolean;
}

export interface SelfImprovementRequesterResult {
  requestedBy: string;
  authorAssociation: string;
  authorizationSource: string;
}

function normalize(value: string): string {
  return String(value || "").trim();
}

function ownerFromRepository(repository: string): string {
  return normalize(repository).split("/")[0] || "";
}

export function resolveSelfImprovementRequester(
  input: SelfImprovementRequesterInput,
  lookup: SelfImprovementRequesterLookup,
): SelfImprovementRequesterResult {
  const eventName = normalize(input.eventName);
  const actor = normalize(input.actor);
  const repository = normalize(input.repository);
  const repositoryOwner = normalize(input.repositoryOwner || ownerFromRepository(repository));
  const repositoryOwnerType = normalize(input.repositoryOwnerType).toLowerCase();

  if (eventName === "schedule") {
    return {
      requestedBy: repositoryOwner || actor || "github-actions[bot]",
      authorAssociation: "OWNER",
      authorizationSource: "system-schedule",
    };
  }

  let authorAssociation = "NONE";
  if (actor) {
    if (repositoryOwnerType === "user" && repositoryOwner && actor.toLowerCase() === repositoryOwner.toLowerCase()) {
      authorAssociation = "OWNER";
    } else if (
      repositoryOwnerType === "organization" &&
      repositoryOwner &&
      lookup.hasOrgMembership(repositoryOwner, actor)
    ) {
      authorAssociation = "MEMBER";
    } else if (repository && lookup.hasRepositoryPermission(repository, actor)) {
      authorAssociation = "COLLABORATOR";
    }
  }

  return {
    requestedBy: actor || repositoryOwner || "github-actions[bot]",
    authorAssociation,
    authorizationSource: eventName === "workflow_dispatch"
      ? "workflow-dispatch-actor"
      : "workflow-actor",
  };
}
