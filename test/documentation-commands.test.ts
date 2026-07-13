import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { commandHelps, renderCommandHelp } from "../src/help.js";

const documents = [
  "README.md",
  "SIGIL_USAGE.md",
  "docs/reference/configuration.md",
  "docs/reference/provider-profiles.md",
  "docs/how-to/configure-provider-profiles.md",
];

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
