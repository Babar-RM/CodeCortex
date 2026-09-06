import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { fetchRepo, cleanupRepo } from "./pipeline/fetch-repo";
import { parseFiles } from "./pipeline/parse-files";
import { buildGraph } from "./pipeline/build-graph";
import { generateEmbeddings } from "./pipeline/generate-embeddings";
import { prisma } from "../lib/prisma";
import { connection, IndexRepoJobPayload } from "./queue";


export async function processIndexingJob(job: Job<IndexRepoJobPayload>): Promise<void> {
  const { indexingJobId, connectedRepoId } = job.data;

  // 1. Fetch repo metadata from Postgres
  const repo = await prisma.connectedRepo.findUnique({
    where: { id: connectedRepoId },
  });

  if (!repo) {
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        status: "FAILED",
        errorMessage: `ConnectedRepo with id ${connectedRepoId} not found`,
        finishedAt: new Date(),
      },
    });
    throw new Error(`ConnectedRepo with id ${connectedRepoId} not found`);
  }

  // 2. Mark status RUNNING
  await prisma.indexingJob.update({
    where: { id: indexingJobId },
    data: {
      status: "RUNNING",
      progressMessage: "Cloning repository...",
      startedAt: new Date(),
    },
  });

  let workspacePath = "";

  try {
    // Stage 1: Fetch Repo (Step 5)
    const fetchResult = await fetchRepo({
      indexingJobId,
      htmlUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
    });
    workspacePath = fetchResult.workspacePath;

    // Stage 2: Parse Files (Step 6)
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        commitSha: fetchResult.commitSha,
        progressMessage: `Parsing ${fetchResult.files.length} source files...`,
      },
    });

    const parseResult = await parseFiles({ files: fetchResult.files });

    // Stage 3: Build Neo4j Graph (Step 7)
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        progressMessage: "Building structural Neo4j code graph...",
      },
    });

    await buildGraph({
      repoId: connectedRepoId,
      repoName: repo.fullName,
      facts: parseResult.symbolFacts,
    });

    // Stage 4: Generate Embeddings (Step 8)
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        progressMessage: "Generating semantic vector embeddings...",
      },
    });

    await generateEmbeddings({
      repoId: connectedRepoId,
      facts: parseResult.symbolFacts,
    });

    // Mark status SUCCEEDED
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        status: "SUCCEEDED",
        progressMessage: "Indexing completed successfully.",
        finishedAt: new Date(),
      },
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Pipeline execution failed";
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        status: "FAILED",
        errorMessage,
        finishedAt: new Date(),
      },
    });
    throw err;
  } finally {
    if (workspacePath) {
      await cleanupRepo(workspacePath);
    }
  }
}

export const indexWorker = new Worker<IndexRepoJobPayload>(
  "index-repo",
  processIndexingJob,
  { connection: connection as unknown as Redis, autorun: false }
);

