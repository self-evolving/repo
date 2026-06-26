#!/usr/bin/env node
// CLI: resolve requester identity and delegated-route authorization context for
// agent-self-improvement.yml.
//
// Schedule runs are system-authorized by the repository owner opt-in
// (`AGENT_SELF_IMPROVEMENT_ENABLED=true`). Manual workflow_dispatch runs use the
// real dispatcher's repository relationship so AGENT_ACCESS_POLICY cannot be
// bypassed by pretending every dispatcher is OWNER.
//
// Env: GITHUB_EVENT_NAME, GITHUB_ACTOR, GITHUB_REPOSITORY,
//      GITHUB_REPOSITORY_OWNER, GITHUB_REPOSITORY_OWNER_TYPE
// Outputs: requested_by, author_association, authorization_source

import { setOutput } from "../output.js";
import {
  hasGithubOrgMembership,
  hasGithubRepositoryPermission,
} from "../actor-association.js";
import { resolveSelfImprovementRequester } from "../self-improvement-requester.js";

function normalize(value: string): string {
  return String(value || "").trim();
}

export function runResolveSelfImprovementRequester(): number {
  const repository = normalize(process.env.GITHUB_REPOSITORY || "");
  const result = resolveSelfImprovementRequester({
    eventName: normalize(process.env.GITHUB_EVENT_NAME || ""),
    actor: normalize(process.env.GITHUB_ACTOR || ""),
    repository,
    repositoryOwner: normalize(process.env.GITHUB_REPOSITORY_OWNER || repository.split("/")[0] || ""),
    repositoryOwnerType: normalize(process.env.GITHUB_REPOSITORY_OWNER_TYPE || ""),
  }, {
    hasOrgMembership: hasGithubOrgMembership,
    hasRepositoryPermission: hasGithubRepositoryPermission,
  });

  setOutput("requested_by", result.requestedBy);
  setOutput("author_association", result.authorAssociation);
  setOutput("authorization_source", result.authorizationSource);
  console.log(
    `Resolved self-improvement requester ${result.requestedBy} as ${result.authorAssociation} (${result.authorizationSource})`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runResolveSelfImprovementRequester();
}
