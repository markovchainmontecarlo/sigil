import { readFile } from "node:fs/promises";

export function readOptionalFile(file: string | undefined): Promise<string | undefined> {
  return file ? readFile(file, "utf8") : Promise.resolve(undefined);
}
