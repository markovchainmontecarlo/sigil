import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { commandHelps, renderCommandHelp } from "../src/help.js";

const rootDocuments = [
  "README.md",
  "SIGIL_USAGE.md",
];

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

const documents = [...rootDocuments, ...markdownFiles("docs")];

function shellCommands(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)]
    .flatMap((match) => match[1].split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("sigil "));
}

describe("documented commands", () => {
  test("fenced Sigil commands use registered commands and rendered flags", () => {
    const names = new Set(commandHelps.map((help) => help.name));
    for (const file of documents) {
      for (const command of shellCommands(readFileSync(file, "utf8"))) {
        const tokens = command.split(/\s+/);
        const name = tokens[1];
        expect(names.has(name as never), `${file}: ${command}`).toBe(true);
        const help = renderCommandHelp(name as never);
        for (const flag of tokens.filter((token) => token.startsWith("--"))) {
          expect(help, `${file}: ${flag}`).toContain(flag);
        }
      }
    }
  });
});
