import { test } from "vitest";
import { verifyCatalog } from "./catalog-generator.js";

test("the committed synthetic catalog matches exact builder output", async () => {
  await verifyCatalog();
});
