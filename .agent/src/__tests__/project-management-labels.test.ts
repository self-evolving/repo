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
    valid: true,
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

test("managed label plan distinguishes malformed and missing json plans", () => {
  assert.deepEqual(parseManagedLabelPlan("## Summary\n\nNo structured plan."), {
    label_changes: [],
    valid: false,
  });
  assert.deepEqual(parseManagedLabelPlan("```json\nnot-json\n```"), {
    label_changes: [],
    valid: false,
  });
  assert.deepEqual(parseManagedLabelPlan("```json\n{\"label_changes\":[]}\n```"), {
    label_changes: [],
    valid: true,
  });
});
