import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { commandHelps } from "../src/help.js";

const outFile = process.argv[2] ?? "man/sigil.1";

function roff(text: string): string {
  return text.replaceAll("\\", "\\e").replaceAll("-", "\\-");
}

const lines = [
  '.TH SIGIL 1',
  '.SH NAME',
  'sigil \\- composable workflow CLI with built-in software-change workflows',
  '.SH SYNOPSIS',
  ...commandHelps.flatMap((help) => ['.B ' + roff(help.usage), '.br']),
  '.SH DESCRIPTION',
  'Sigil is a composable workflow system with built-in software-change workflows. Run \\fBsigil <verb> --help\\fR for command-specific help.',
  '.SH COMMANDS',
  ...commandHelps.flatMap((help) => [
    `.SS ${roff(help.name)}`,
    roff(help.summary),
    '.P',
    `Usage: \\fB${roff(help.usage)}\\fR`,
    '.P',
    'Arguments and flags:',
    ...help.flags.flatMap((flag) => ['.TP', `\\fB${roff(flag.name)}\\fR`, roff(flag.description)]),
    '.P',
    `Exit codes: ${roff(help.exitCode)}`,
  ]),
  '.SH SEE ALSO',
  'sigil <verb> --help',
  '',
];

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${lines.join("\n")}\n`);
