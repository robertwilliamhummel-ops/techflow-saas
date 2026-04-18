import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — googleapis must be mocked before handler import
// ---------------------------------------------------------------------------

const mockExportDocuments = vi.fn().mockResolvedValue({ data: {} });

vi.mock("googleapis", () => ({
  google: {
    firestore: () => ({
      projects: {
        databases: {
          exportDocuments: mockExportDocuments,
        },
      },
    }),
  },
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { scheduledFirestoreExportHandler } from "../../src/scheduled/firestoreExport";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduledFirestoreExport", () => {
  const ORIG_PROJECT = process.env.GCLOUD_PROJECT;

  beforeEach(() => {
    mockExportDocuments.mockClear();
    process.env.GCLOUD_PROJECT = "techflow-test-project";
  });

  afterEach(() => {
    if (ORIG_PROJECT !== undefined) {
      process.env.GCLOUD_PROJECT = ORIG_PROJECT;
    }
  });

  it("calls exportDocuments with correct project and bucket", async () => {
    await scheduledFirestoreExportHandler();

    expect(mockExportDocuments).toHaveBeenCalledTimes(1);

    const call = mockExportDocuments.mock.calls[0][0];
    expect(call.name).toBe(
      "projects/techflow-test-project/databases/(default)",
    );
    expect(call.requestBody.outputUriPrefix).toMatch(
      /^gs:\/\/techflow-test-project-firestore-backups\/daily\/\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("uses today's date as the timestamp path segment", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await scheduledFirestoreExportHandler();

    const prefix =
      mockExportDocuments.mock.calls[0][0].requestBody.outputUriPrefix;
    expect(prefix).toContain(`/daily/${today}`);
  });

  it("propagates errors from exportDocuments", async () => {
    mockExportDocuments.mockRejectedValueOnce(
      new Error("PERMISSION_DENIED: missing IAM role"),
    );

    await expect(scheduledFirestoreExportHandler()).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
  });

  it("exports all collections (no collectionIds filter)", async () => {
    await scheduledFirestoreExportHandler();

    const body = mockExportDocuments.mock.calls[0][0].requestBody;
    // collectionIds should be absent or empty — export all
    expect(body.collectionIds).toBeUndefined();
  });
});
