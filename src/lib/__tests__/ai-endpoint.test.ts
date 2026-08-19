import { describe, expect, it } from "vitest";
import { classifyAiEndpoint, AI_ENDPOINT_GUIDANCE } from "@/lib/ai-endpoint";
import { streamReadiness } from "@/lib/stream-health";

describe("classifyAiEndpoint", () => {
  it("treats an empty endpoint as unset", () => {
    expect(classifyAiEndpoint("")).toBe("unset");
    expect(classifyAiEndpoint(undefined)).toBe("unset");
  });

  it("rejects non-http(s) and credential-bearing URLs", () => {
    expect(classifyAiEndpoint("rtsp://192.168.1.64:554/x")).toBe("invalid");
    expect(classifyAiEndpoint("not a url")).toBe("invalid");
    expect(classifyAiEndpoint("http://user:pass@example.com")).toBe("invalid");
  });

  it("classifies loopback, LAN and bare hostnames as local only", () => {
    for (const value of [
      "http://127.0.0.1:8000",
      "http://localhost:8000",
      "http://192.168.1.50:8000",
      "http://10.0.0.4:8000",
      "http://172.20.3.9:8000",
      "http://169.254.10.10:8000",
      "http://laptop:8000",
      "http://laptop.local:8000",
    ]) {
      expect(classifyAiEndpoint(value), value).toBe("local_only");
    }
  });

  it("classifies a public HTTPS tunnel as public", () => {
    expect(classifyAiEndpoint("https://ai-abc123.trycloudflare.com")).toBe("public");
    expect(classifyAiEndpoint("https://vigilant.example.org:8443/")).toBe("public");
  });

  it("only omits guidance for a public endpoint", () => {
    expect(AI_ENDPOINT_GUIDANCE.public).toBeNull();
    expect(AI_ENDPOINT_GUIDANCE.local_only).toContain("public HTTPS tunnel");
  });
});

describe("streamReadiness endpoint reachability", () => {
  const base = {
    cameraId: "cam-1",
    cameraOffline: false,
    healthFailed: false,
    healthPending: false,
  };

  it("reports an unreachable local endpoint distinctly", () => {
    const readiness = streamReadiness({
      ...base,
      health: { ok: false, message: "unreachable", reach: "local_only" },
    });
    expect(readiness.state).toBe("service_unreachable");
    expect(readiness.displayable).toBe(false);
  });

  it("falls back to awaiting service when no reach is reported", () => {
    expect(streamReadiness({ ...base, health: { ok: false, message: "boom" } }).state).toBe(
      "awaiting_service",
    );
  });

  it("still reports live for a healthy public endpoint", () => {
    expect(
      streamReadiness({
        ...base,
        health: { ok: true, cameras: [{ id: "cam-1", connected: true, streaming: true }] },
      }).state,
    ).toBe("live");
  });
});
