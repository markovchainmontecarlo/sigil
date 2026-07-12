import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sigil, type RichSigilAgent, type SigilContext } from "sigil";
import { z } from "zod";

const assignmentSchema = z.object({
  assignments: z.array(z.object({
    title: z.string().min(1),
    question: z.string().min(1),
    startingPoints: z.array(z.string().min(1)),
    exclusions: z.array(z.string().min(1)),
  })).length(3),
});

const auditSchema = z.object({
  accurate: z.boolean(),
  comprehensive: z.boolean(),
  findings: z.array(z.string().min(1)),
});

type Assignment = z.infer<typeof assignmentSchema>["assignments"][number];
type Audit = z.infer<typeof auditSchema>;

export type ArchitectureDocumentationInput = {
  repo: string;
  lead?: string;
  explorer?: string;
};

export type ArchitectureDocumentationResult = {
  architectureFile: string;
  reports: string[];
  audit: Audit;
  valid: boolean;
  issues: readonly string[];
};

const LEAD_INSPECTION_PROMPT = `
Inspect the repository and its root ARCHITECTURE.md when one exists. Work read-only.
Build a source-grounded model of the system rather than trusting documentation.
Identify entrypoints, principal components, ownership boundaries, dependency direction,
state transitions, external effects, authority boundaries, and failure propagation.
Report what the source establishes and what still needs investigation.
`;

const LEAD_MODEL_PROMPT = `
Deepen your repository model. Follow the most important dependencies and execution paths
that your first inspection exposed. Look for competing state writers, indirect callers,
cross-cutting runtime behavior, and exceptions to apparent boundaries. Correct your earlier
model where the source contradicts it. Work read-only.
`;

const LEAD_COMPLETENESS_PROMPT = `
Test whether your repository model is comprehensive enough to write the architecture
document. Search for important surfaces you have not accounted for, verify questionable
claims, and distinguish architectural structure from implementation detail. Work read-only.
`;

const LEAD_DRAFT_PROMPT = `
Write a complete root ARCHITECTURE.md from the repository model you have verified.
Return only the Markdown document, beginning with the exact top-level heading
"# Architecture" as its first line. Describe stable structure, ownership, dependency
direction, state flow, effects, failure boundaries, and extension points that the source
supports. Include Mermaid diagrams where they materially clarify relationships. Do not
record volatile counts, versions, timestamps, status snapshots, line numbers, or incident
history. Replace inaccurate existing material rather than preserving it as legacy text.
`;

const INITIAL_ASSIGNMENTS_PROMPT = `
Choose three distinct assignments that would most improve the current ARCHITECTURE.md.
Derive them from the repository and document rather than from a fixed domain list. Together
they should target the most consequential uncertainty, missing detail, or weakly supported
claims. Starting points are advisory repository-relative paths or symbols. Exclusions prevent
overlap between the three assignments. The explorers will work read-only.
`;

const FOLLOW_UP_ASSIGNMENTS_PROMPT = `
Choose three new, distinct follow-up assignments after reading the current architecture and
the first investigation reports. Do not repeat completed work. Target remaining gaps,
cross-boundary relationships, or claims that need deeper verification. Starting points are
advisory repository-relative paths or symbols. Exclusions prevent overlap. The explorers
will work read-only.
`;

const EXPLORER_INVESTIGATE_PROMPT = `
Read the current root ARCHITECTURE.md and investigate your assigned question against source.
Follow justified dependencies beyond the starting points. Do not edit repository files.
Separate verified facts from open questions and record the paths and symbols that support
each material conclusion.
`;

const EXPLORER_DEEPEN_PROMPT = `
Deepen the investigation using what you have learned. Trace the most important relationships
end to end, test the document's claims, look for missing ownership or failure paths, and
correct your initial conclusions where necessary. Do not edit repository files.
`;

const EXPLORER_REPORT_PROMPT = `
Produce a concise, source-grounded report for the lead author. State accurate existing
claims, inaccurate claims, missing architectural detail, and the exact corrections the
document needs. Include repository-relative paths and symbols as evidence. Return only the
report Markdown. Do not edit repository files.
`;

const RECONCILE_REPORTS_PROMPT = `
Reconcile the three investigation reports against your repository model. Reject unsupported
recommendations, resolve contradictions by checking source, and identify the document changes
that the combined evidence warrants. Work read-only and retain the current document's useful
material.
`;

const UPDATE_DOCUMENT_PROMPT = `
Update the current ARCHITECTURE.md from the verified investigation findings. Return only the
complete replacement Markdown document, beginning with the exact top-level heading
"# Architecture" as its first line. Keep it coherent as one architecture explanation,
not a collection of reports or a change log. Do not add volatile counts, versions, timestamps,
status snapshots, line numbers, or incident history.
`;

const FINAL_AUDIT_PROMPT = `
Audit the final ARCHITECTURE.md against the repository. Determine whether every material claim
is accurate and whether the document covers the important architectural boundaries and flows.
Report only actionable defects. Do not edit repository files.
`;

const FINAL_REPAIR_PROMPT = `
Repair every verified audit finding in ARCHITECTURE.md. Return only the complete replacement
Markdown document, beginning with the exact top-level heading "# Architecture" as its first
line. Preserve correct material, remove unsupported claims, and add only detail
supported by source.
`;

export default sigil(
  "architecture-documentation",
  async (
    ctx,
    input: ArchitectureDocumentationInput,
  ): Promise<ArchitectureDocumentationResult> => {
    const repo = resolve(input.repo);
    const architectureFile = join(repo, "ARCHITECTURE.md");
    const leadRole = input.lead ?? "explorer";
    const explorerRole = input.explorer ?? "explorer";

    await requireCleanRepository(ctx);

    await using lead = ctx.agent(leadRole);
    const initialArchitecture = await draftInitialArchitecture(lead);
    await saveArchitecture(ctx, architectureFile, "architecture/initial.md", initialArchitecture);

    const initialAssignments = await lead.prompt(
      INITIAL_ASSIGNMENTS_PROMPT,
      assignmentSchema,
    );
    const initialReports = await investigateRound(
      ctx,
      explorerRole,
      initialAssignments.assignments,
      initialArchitecture,
      "initial",
    );
    const revisedArchitecture = await reviseArchitecture(
      lead,
      initialArchitecture,
      initialReports.contents,
    );
    await saveArchitecture(ctx, architectureFile, "architecture/revised.md", revisedArchitecture);

    const followUpAssignments = await lead.prompt(
      FOLLOW_UP_ASSIGNMENTS_PROMPT,
      assignmentSchema,
    );
    const followUpReports = await investigateRound(
      ctx,
      explorerRole,
      followUpAssignments.assignments,
      revisedArchitecture,
      "follow-up",
    );
    const finalArchitecture = await reviseArchitecture(
      lead,
      revisedArchitecture,
      followUpReports.contents,
    );
    await saveArchitecture(ctx, architectureFile, "architecture/final.md", finalArchitecture);

    const initialAudit = await auditArchitecture(lead, finalArchitecture);
    const repairedArchitecture = await repairArchitecture(lead, finalArchitecture, initialAudit);
    await saveArchitecture(ctx, architectureFile, "architecture/verified.md", repairedArchitecture);

    const audit = repairedArchitecture === finalArchitecture
      ? initialAudit
      : await auditArchitecture(lead, repairedArchitecture);
    const verified = await verifyResult(ctx, architectureFile);
    const valid = verified
      && audit.accurate
      && audit.comprehensive
      && audit.findings.length === 0;
    if (!valid) ctx.issue("final architecture accuracy or coverage audit failed");
    return {
      architectureFile,
      reports: [...initialReports.paths, ...followUpReports.paths],
      audit,
      valid,
      issues: ctx.issues,
    };
  },
);

async function draftInitialArchitecture(lead: RichSigilAgent): Promise<string> {
  await lead.prompt(LEAD_INSPECTION_PROMPT);
  await lead.prompt(LEAD_MODEL_PROMPT);
  await lead.prompt(LEAD_COMPLETENESS_PROMPT);
  return lead.prompt(LEAD_DRAFT_PROMPT);
}

async function investigateRound(
  ctx: SigilContext,
  role: string,
  assignments: Assignment[],
  architecture: string,
  round: string,
): Promise<{ contents: string[]; paths: string[] }> {
  const contents = await ctx.parallel(assignments.map((assignment) => async () => (
    ctx.withAgent(role, async (explorer) => {
      await explorer.prompt(explorerPrompt(EXPLORER_INVESTIGATE_PROMPT, assignment, architecture));
      await explorer.prompt(explorerPrompt(EXPLORER_DEEPEN_PROMPT, assignment, architecture));
      return explorer.prompt(explorerPrompt(EXPLORER_REPORT_PROMPT, assignment, architecture));
    })
  )));
  const paths = await Promise.all(contents.map((report, index) => (
    ctx.artifacts.write(`architecture/${round}/explorer-${index + 1}.md`, report)
  )));
  return { contents, paths };
}

async function reviseArchitecture(
  lead: RichSigilAgent,
  architecture: string,
  reports: string[],
): Promise<string> {
  await lead.prompt([
    RECONCILE_REPORTS_PROMPT,
    architectureBlock(architecture),
    reportsBlock(reports),
  ].join("\n\n"));
  return lead.prompt([
    UPDATE_DOCUMENT_PROMPT,
    architectureBlock(architecture),
    reportsBlock(reports),
  ].join("\n\n"));
}

async function auditArchitecture(
  lead: RichSigilAgent,
  architecture: string,
): Promise<Audit> {
  return lead.prompt(
    [FINAL_AUDIT_PROMPT, architectureBlock(architecture)].join("\n\n"),
    auditSchema,
  );
}

async function repairArchitecture(
  lead: RichSigilAgent,
  architecture: string,
  audit: Audit,
): Promise<string> {
  if (audit.accurate && audit.comprehensive && audit.findings.length === 0) {
    return architecture;
  }
  return lead.prompt([
    FINAL_REPAIR_PROMPT,
    architectureBlock(architecture),
    `AUDIT FINDINGS:\n${audit.findings.map((finding) => `- ${finding}`).join("\n")}`,
  ].join("\n\n"));
}

async function saveArchitecture(
  ctx: SigilContext,
  architectureFile: string,
  artifactName: string,
  contents: string,
): Promise<void> {
  const normalized = normalizeArchitecture(contents);
  await writeFile(architectureFile, normalized);
  await ctx.artifacts.write(artifactName, normalized);
}

async function requireCleanRepository(ctx: SigilContext): Promise<void> {
  const status = await ctx.sh({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
  });
  if (!status.ok) throw new Error(`cannot inspect repository status: ${status.stderr}`);
  if (status.stdout.trim()) throw new Error("architecture documentation requires a clean repository");
}

async function verifyResult(ctx: SigilContext, architectureFile: string): Promise<boolean> {
  await access(architectureFile);
  const contents = await readFile(architectureFile, "utf8");
  const status = await ctx.sh({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
  });
  const diff = await ctx.sh({ command: "git", args: ["diff", "--check"] });
  const changedFiles = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const onlyArchitectureChanged = changedFiles.length === 0
    || (changedFiles.length === 1 && changedFiles[0] === "ARCHITECTURE.md");
  const valid = contents.startsWith("# Architecture\n")
    && onlyArchitectureChanged
    && status.ok
    && diff.ok;
  if (!valid) ctx.issue("final architecture document verification failed");
  return valid;
}

function explorerPrompt(
  instruction: string,
  assignment: Assignment,
  architecture: string,
): string {
  return [
    instruction,
    `ASSIGNMENT:\n${JSON.stringify(assignment, null, 2)}`,
    architectureBlock(architecture),
  ].join("\n\n");
}

function architectureBlock(architecture: string): string {
  return `CURRENT ARCHITECTURE.md:\n${architecture}`;
}

function reportsBlock(reports: string[]): string {
  return reports
    .map((report, index) => `EXPLORER REPORT ${index + 1}:\n${report}`)
    .join("\n\n");
}

function normalizeArchitecture(contents: string): string {
  const normalized = contents.trim();
  if (!normalized.startsWith("# Architecture")) {
    throw new Error("generated architecture document must start with '# Architecture'");
  }
  return `${normalized}\n`;
}
