import { describe, expect, test } from "bun:test";
import { slugifyBranch } from "../src/workflows/software-change/implementation/index.js";

describe("slugifyBranch", () => {
  test("takes basename of an absolute path (the plan-project-as-path case)", () => {
    expect(slugifyBranch("/Users/jeremypatrick/projects/angular-todo")).toBe("angular-todo");
  });
  test("sanitizes disallowed chars and trims", () => {
    expect(slugifyBranch("My Feature! (v2)")).toBe("My-Feature-v2");
  });
  test("never yields empty or slash-bearing slug", () => {
    expect(slugifyBranch("///")).toBe("implement");
    expect(slugifyBranch("")).toBe("implement");
    expect(slugifyBranch("a/b/c")).toBe("c");
  });
  test("caps length at 60", () => {
    expect(slugifyBranch("x".repeat(200)).length).toBe(60);
  });
});
