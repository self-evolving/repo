import { test } from "node:test";
import { strict as assert } from "node:assert";

import { resolveSelfImprovementRequester } from "../self-improvement-requester.js";

const lookup = {
  hasOrgMembership(orgLogin: string, userLogin: string): boolean {
    return orgLogin === "co-evolving" && userLogin === "member";
  },
  hasRepositoryPermission(repository: string, userLogin: string): boolean {
    return repository === "co-evolving/repo" && userLogin === "collab";
  },
};

test("scheduled self-improvement runs use system owner authorization", () => {
  const result = resolveSelfImprovementRequester({
    eventName: "schedule",
    actor: "github-actions[bot]",
    repository: "co-evolving/repo",
    repositoryOwner: "co-evolving",
    repositoryOwnerType: "Organization",
  }, lookup);

  assert.deepEqual(result, {
    requestedBy: "co-evolving",
    authorAssociation: "OWNER",
    authorizationSource: "system-schedule",
  });
});

test("manual self-improvement dispatch maps user-owned repositories to OWNER", () => {
  const result = resolveSelfImprovementRequester({
    eventName: "workflow_dispatch",
    actor: "alice",
    repository: "alice/repo",
    repositoryOwner: "alice",
    repositoryOwnerType: "User",
  }, lookup);

  assert.deepEqual(result, {
    requestedBy: "alice",
    authorAssociation: "OWNER",
    authorizationSource: "workflow-dispatch-actor",
  });
});

test("manual self-improvement dispatch derives the real actor association", () => {
  assert.equal(resolveSelfImprovementRequester({
    eventName: "workflow_dispatch",
    actor: "member",
    repository: "co-evolving/repo",
    repositoryOwner: "co-evolving",
    repositoryOwnerType: "Organization",
  }, lookup).authorAssociation, "MEMBER");

  assert.equal(resolveSelfImprovementRequester({
    eventName: "workflow_dispatch",
    actor: "collab",
    repository: "co-evolving/repo",
    repositoryOwner: "co-evolving",
    repositoryOwnerType: "Organization",
  }, lookup).authorAssociation, "COLLABORATOR");

  assert.equal(resolveSelfImprovementRequester({
    eventName: "workflow_dispatch",
    actor: "outside-user",
    repository: "co-evolving/repo",
    repositoryOwner: "co-evolving",
    repositoryOwnerType: "Organization",
  }, lookup).authorAssociation, "NONE");
});
