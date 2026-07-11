import { mkdirSync } from "node:fs";

import { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";

import { softwareChange } from "./workflows/software-change/workflow.js";

const defaultStorageDir = ".mastra";
const defaultStorageFile = `${defaultStorageDir}/sigil.db`;
const defaultStorageUrl = `file:${defaultStorageFile}`;

function defaultStorage(): LibSQLStore {
  mkdirSync(defaultStorageDir, { recursive: true });
  return new LibSQLStore({ id: "sigil", url: defaultStorageUrl });
}

const softwareChangeInputSchema = z.object({
  intent: z.string(),
  repo: z.string(),
  brief: z.string().optional(),
  instructions: z.string().optional(),
  outFile: z.string().optional(),
  taskFile: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
});

const planResultSchema = z.object({
  taskFile: z.string(),
  taskCount: z.number(),
  valid: z.boolean(),
  issues: z.array(z.string()),
});

const implementationResultSchema = z.object({
  branch: z.string(),
  prBody: z.string(),
  reviewBlocking: z.boolean(),
  issues: z.array(z.string()),
  failedTasks: z.array(z.string()),
  noopTasks: z.array(z.string()),
});

const softwareChangeResultSchema = z.object({
  stage: z.enum(["planning", "implementation"]),
  taskFile: z.string(),
  taskCount: z.number(),
  valid: z.boolean(),
  plan: planResultSchema,
  implementation: implementationResultSchema.optional(),
  branch: z.string().optional(),
  prBody: z.string().optional(),
  reviewBlocking: z.boolean(),
  issues: z.array(z.string()),
  failedTasks: z.array(z.string()),
  noopTasks: z.array(z.string()),
});

const softwareChangeStep = createStep({
  id: "software-change",
  inputSchema: softwareChangeInputSchema,
  outputSchema: softwareChangeResultSchema,
  execute: async ({ inputData }) => softwareChange(inputData),
});

export const swe = createWorkflow({
  id: "swe",
  inputSchema: softwareChangeInputSchema,
  outputSchema: softwareChangeResultSchema,
})
  .then(softwareChangeStep)
  .commit();

export const mastra = new Mastra({
  storage: defaultStorage(),
  workflows: { swe },
});
