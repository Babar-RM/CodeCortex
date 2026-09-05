import { describe, it, expect } from "vitest";
import { IndexingStatus, ChatRole } from "@prisma/client";

describe("Prisma Schema Data Contracts (RFC 0003)", () => {
  it("should define valid IndexingStatus enum values", () => {
    expect(IndexingStatus.PENDING).toBe("PENDING");
    expect(IndexingStatus.RUNNING).toBe("RUNNING");
    expect(IndexingStatus.SUCCEEDED).toBe("SUCCEEDED");
    expect(IndexingStatus.FAILED).toBe("FAILED");
  });

  it("should define valid ChatRole enum values", () => {
    expect(ChatRole.USER).toBe("USER");
    expect(ChatRole.ASSISTANT).toBe("ASSISTANT");
    expect(ChatRole.SYSTEM).toBe("SYSTEM");
  });
});
