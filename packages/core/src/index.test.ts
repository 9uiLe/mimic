import { expect, test } from "vitest";
import { getStatus } from "./index.js";

test("core status reports ready", () => {
  expect(getStatus()).toEqual({ name: "mimic", state: "ready" });
});
