import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { fetchRepo, cleanupRepo, computeFileDiff } from "./pipeline/fetch-repo";
import { parseFiles } from "./pipeline/parse-files";
import { buildGraph } from "./pipeline/build-graph";
import { generateEmbeddings } from "./pipeline/generate-embeddings";
import { cleanupDeletedFiles } from "./pipeline/incremental-cleanup";
import { getInstallationAccessToken } from "../lib/github-app";
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
    let accessToken: string | undefined;
    if (repo.installationId) {
      accessToken = await getInstallationAccessToken({ installationId: repo.installationId });
    }

    // Stage 1: Fetch Repo (Step 5 & RFC 0021)
    const fetchResult = await fetchRepo({
      indexingJobId,
      htmlUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
      installationId: repo.installationId ?? undefined,
      accessToken,
    });
    workspacePath = fetchResult.workspacePath;

    // Check No-Op Short-Circuit (RFC 0018): If commit SHA is identical to lastIndexedCommitSha
    if (
      repo.lastIndexedCommitSha &&
      fetchResult.commitSha !== "unknown" &&
      repo.lastIndexedCommitSha === fetchResult.commitSha
    ) {
      await prisma.indexingJob.update({
        where: { id: indexingJobId },
        data: {
          status: "SUCCEEDED",
          commitSha: fetchResult.commitSha,
          progressMessage: "Repository is up to date (no changes detected).",
          finishedAt: new Date(),
        },
      });
      return;
    }

    let filesToProcess = fetchResult.files;
    let deletedFiles: string[] = [];
    let modifiedFiles: string[] = [];

    // Incremental Diff Logic if previously indexed commit exists
    if (
      repo.lastIndexedCommitSha &&
      fetchResult.commitSha !== "unknown" &&
      repo.lastIndexedCommitSha !== fetchResult.commitSha
    ) {
      const diffResult = await computeFileDiff(
        workspacePath,
        repo.lastIndexedCommitSha,
        fetchResult.commitSha
      );
      deletedFiles = diffResult.deletedFiles;
      modifiedFiles = diffResult.modifiedFiles;

      const changedPaths = new Set([...diffResult.addedFiles, ...diffResult.modifiedFiles]);
      if (changedPaths.size > 0) {
        filesToProcess = fetchResult.files.filter((f) => changedPaths.has(f.relativePath));
      }
    }

    // Execute cleanup for deleted files and stale insight caches
    if (deletedFiles.length > 0 || modifiedFiles.length > 0) {
      await cleanupDeletedFiles({
        repoId: connectedRepoId,
        deletedFilePaths: deletedFiles,
        modifiedFilePaths: modifiedFiles,
      });
    }

    // Stage 2: Parse Files (Step 6)
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        commitSha: fetchResult.commitSha,
        progressMessage: `Parsing ${filesToProcess.length} changed source files...`,
      },
    });

    const parseResult = await parseFiles({ files: filesToProcess });

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

    // Update lastIndexedCommitSha on ConnectedRepo
    if (fetchResult.commitSha && fetchResult.commitSha !== "unknown") {
      await prisma.connectedRepo.update({
        where: { id: connectedRepoId },
        data: { lastIndexedCommitSha: fetchResult.commitSha },
      });
    }

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

