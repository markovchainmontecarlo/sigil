#!/usr/bin/env bun
import { review } from "../src/workflows/software-change/review/index.ts";

const repo = process.cwd();
const base = process.argv[2] ?? "main";
const result = await review({ repo, base, autofix: false, context: "Demo review against this checkout's real diff." });

if (result.issues.length) {
  console.error(result.issues.join("\n"));
  process.exit(1);
}

console.log(`findings file: ${result.findingsFile}`);
console.log(`unresolved high: ${result.unresolvedHigh}`);
