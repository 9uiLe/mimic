import { expect, test } from "vitest";
import { parseArtifactYaml } from "./check-yaml.mjs";

test("native YAML accepts one JSON-compatible mapping", () => {
  expect(parseArtifactYaml("name: mimic\ncount: 1\n")).toEqual({
    name: "mimic",
    count: 1,
  });
});

test("native YAML rejects duplicate keys and non-JSON values", () => {
  expect(() => parseArtifactYaml("name: one\nname: two\n")).toThrow();
  expect(() => parseArtifactYaml("value: .nan\n")).toThrow(/JSON-compatible/);
  expect(() => parseArtifactYaml("- item\n")).toThrow(/one mapping/);
});

test("native YAML rejects keys that could collide or stringify during conversion", () => {
  expect(() => parseArtifactYaml("1: first\n")).toThrow(/keys must be strings/);
  expect(() => parseArtifactYaml('1: first\n"1": second\n')).toThrow();
  expect(() =>
    parseArtifactYaml('nested:\n  1: first\n  "1": second\n'),
  ).toThrow(/keys must be strings/);
  expect(() =>
    parseArtifactYaml("? [a, b]\n: first\n? [a, b]\n: second\n"),
  ).toThrow();
  expect(parseArtifactYaml('"1": first\n')).toEqual({ 1: "first" });
});
