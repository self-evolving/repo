import { test } from "node:test";
import { strict as assert } from "node:assert";

import { hasLiveMention, stripNonLiveMentions } from "../mentions.js";

const MENTION = "@sepo-agent";

test("stripNonLiveMentions removes quoted text and fenced code", () => {
  const md = [
    "Look at this:",
    "```",
    `${MENTION} in a code block`,
    "```",
    `> ${MENTION} in a quote`,
    `Normal text here`,
    `Inline code \`${MENTION}\` here`,
  ].join("\n");

  const stripped = stripNonLiveMentions(md);
  assert.ok(!stripped.includes("code block"), "code block should be stripped");
  assert.ok(!stripped.includes("in a quote"), "quoted line should be stripped");
  assert.ok(!stripped.includes(MENTION), "inline code mention should be stripped");
  assert.ok(stripped.includes("Normal text"), "plain text should survive");
  assert.ok(stripped.includes("Inline code"), "text around inline code should survive");
});

test("hasLiveMention enforces mention boundaries", () => {
  assert.ok(hasLiveMention(`Please ${MENTION} review this`, MENTION));
  assert.ok(hasLiveMention(`${MENTION} review this`, MENTION));
  assert.ok(hasLiveMention(`Hey (${MENTION}) here`, MENTION));
  assert.ok(!hasLiveMention(`\`${MENTION}\``, MENTION), "inline code");
  assert.ok(!hasLiveMention(`> ${MENTION}`, MENTION), "blockquote");
  assert.ok(
    !hasLiveMention(`prefix${MENTION}suffix`, MENTION),
    "no boundary around mention",
  );
});
