/**
 * Vitest global setup file — runs once before all tests.
 *
 * Why this file exists:
 * `queue.ts` creates a Redis connection at module-evaluation time via
 * `new Redis(...)`.  Any test file that transitively imports `queue.ts`
 * (e.g. orchestration.test.ts → ../jobs/queue, or repos.test.ts →
 * ../index → routes/repos.ts → ../jobs/queue) will trigger a live TCP
 * connection attempt.  In CI (GitHub Actions) that connection lands on
 * 127.0.0.1:6379, which is fine when REDIS_URL is exported — but the
 * BullMQ Queue constructor itself still emits un-catchable
 * AggregateError events that show up as test noise / failures.
 *
 * The `vi.mock` calls here hoist above all imports in every test file,
 * silencing the connection entirely for the unit-test suite.  Integration
 * tests that actually need a live queue should be placed in a separate
 * test suite that does NOT use this setup file.
 */

import { vi } from "vitest";

// Mock the BullMQ queue module so no Redis connection is created during tests.
// Each test that needs specific queue behaviour can override with vi.mocked().
vi.mock("../jobs/queue", () => ({
  indexRepoQueue: {
    name: "index-repo",
    add: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  },
  connection: {
    status: "ready",
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(3600),
    get: vi.fn().mockResolvedValue(null),
    incrby: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    on: vi.fn(),
  },
  closeQueue: vi.fn().mockResolvedValue(undefined),
}));
