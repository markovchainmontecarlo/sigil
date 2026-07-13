import { expect, test } from "bun:test";

import { packageResource } from "../src/prompts.js";

test("resource resolution rejects paths outside the declared logical boundary", () => {
  for (const invalid of ["/etc/passwd", "../package.json", "workflows/../package.json", "", "dashboard/private.txt"]) {
    expect(() => packageResource(invalid)).toThrow();
  }
});
