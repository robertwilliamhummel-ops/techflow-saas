import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — googleapis must be mocked before handler import
// ---------------------------------------------------------------------------

// vi.hoisted: the vi.mock factory runs before module-level consts exist.
const { mockExportDocuments, mockFirestoreClient, MockGoogleAuth } = vi.hoisted(() => {
  const mockExportDocuments = vi.fn().mockResolvedValue({ data: {} });
  return {
    mockExportDocuments,
    // Records the options the handler builds the client with, so a missing
    // `auth` fails here instead of at 03:00 in production.
    mockFirestoreClient: vi.fn(() => ({
      projects: { databases: { exportDocuments: mockExportDocuments } },
    })),
    MockGoogleAuth: vi.fn(function (this: { opts: unknown }, opts: unknown) {
      this.opts = opts;
    }),
  };
});

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: MockGoogleAuth },
    firestore: mockFirestoreClient,
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
    mockFirestoreClient.mockClear();
    MockGoogleAuth.mockClear();
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

  it("authenticates as the function's service account (staging exports failed unauthenticated)", async () => {
    await scheduledFirestoreExportHandler();

    expect(MockGoogleAuth).toHaveBeenCalledTimes(1);
    const authOpts = MockGoogleAuth.mock.calls[0][0] as { scopes: string[] };
    expect(authOpts.scopes).toContain("https://www.googleapis.com/auth/datastore");

    expect(mockFirestoreClient).toHaveBeenCalledTimes(1);
    const clientOpts = mockFirestoreClient.mock.calls[0][0] as { version: string; auth: unknown };
    expect(clientOpts.version).toBe("v1");
    expect(clientOpts.auth).toBeInstanceOf(MockGoogleAuth);
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
