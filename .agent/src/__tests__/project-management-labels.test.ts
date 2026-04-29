import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseManagedLabelPlan } from "../project-management-labels.js";

test("managed label plan keeps only allowed project-management labels", () => {
  const plan = parseManagedLabelPlan(`
## Project Management Summary

\`\`\`json
{
  "label_changes": [
    {
      "kind": "issue",
      "number": 34,
      "add": ["priority/p1", "bug", "effort/high"],
      "remove": ["priority/p3", "external"]
    },
    {
      "kind": "discussion",
      "number": 7,
      "add": ["priority/p0"],
      "remove": []
    }
  ],
  "comments": [{"body": "not allowed"}]
}
\`\`\`
`);

  assert.deepEqual(plan, {
    label_changes: [
      {
        kind: "issue",
        number: 34,
        add: ["priority/p1", "effort/high"],
        remove: ["priority/p3"],
      },
    ],
  });
});
