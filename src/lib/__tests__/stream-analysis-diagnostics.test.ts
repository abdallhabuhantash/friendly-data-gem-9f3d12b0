import { describe, expect, it } from "vitest";
import { minimalCameraStreamHealth, streamReadiness } from "@/lib/stream-health";

const CAMERA = "11111111-1111-1111-1111-111111111111";

function readinessFor(camera: Record<string, unknown>) {
  return streamReadiness({
    cameraId: CAMERA,
    cameraOffline: false,
    health: { ok: true, cameras: minimalCameraStreamHealth({ cameras: [camera] }) },
    healthFailed: false,
    healthPending: false,
    healthUpdatedAt: 1_000,
    now: 1_500,
  });
}

describe("analysis diagnostics from the AI service /status document", () => {
  it("parses the analysis facts without inventing them", () => {
    const [entry] = minimalCameraStreamHealth({
      cameras: [{ id: CAMERA, connected: true, streaming: false, ai_enabled: false, analysis_error: "RuntimeError" }],
    });
    expect(entry).toMatchObject({ analysisEnabled: false, analysisError: "RuntimeError" });
  });

  it("treats a service that does not report the fields as analysis-enabled", () => {
    const [entry] = minimalCameraStreamHealth({
      cameras: [{ id: CAMERA, connected: true, streaming: true }],
    });
    expect(entry?.analysisEnabled).toBe(true);
    expect(entry?.analysisError).toBeNull();
  });

  it("reports analysis disabled instead of a generic stall", () => {
    const result = readinessFor({ id: CAMERA, connected: true, streaming: false, ai_enabled: false });
    expect(result.state).toBe("analysis_disabled");
    expect(result.displayable).toBe(false);
  });

  it("reports a failing analysis pipeline", () => {
    const result = readinessFor({
      id: CAMERA,
      connected: true,
      streaming: false,
      analysis_error: "FileNotFoundError",
    });
    expect(result.state).toBe("analysis_failed");
  });

  it("still reports a plain stall when analysis is healthy but no frame exists yet", () => {
    const result = readinessFor({ id: CAMERA, connected: true, streaming: false });
    expect(result.state).toBe("stalled");
  });

  it("never lets a diagnostic override a genuinely live stream", () => {
    const result = readinessFor({
      id: CAMERA,
      connected: true,
      streaming: true,
      analysis_error: "TransientError",
    });
    expect(result.state).toBe("live");
    expect(result.displayable).toBe(true);
  });
});
