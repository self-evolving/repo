import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseReleaseVersion } from "../release-version.js";

test("parseReleaseVersion accepts plain SemVer and optional v prefix", () => {
  assert.deepEqual(parseReleaseVersion("0.2.0"), {
    version: "0.2.0",
    tag: "v0.2.0",
    major: 0,
    minor: 2,
    patch: 0,
    prereleaseLabel: "",
  });
  assert.equal(parseReleaseVersion("v1.0.0-rc.1").version, "1.0.0-rc.1");
});

test("parseReleaseVersion rejects build metadata and leading zero prerelease numbers", () => {
  assert.throws(() => parseReleaseVersion("1.0.0+build.1"), /version must be SemVer/);
  assert.throws(() => parseReleaseVersion("1.0.0-rc.01"), /version must be SemVer/);
});
