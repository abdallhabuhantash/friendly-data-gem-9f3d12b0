import { Cpu, Grid2X2, Maximize2, VideoOff } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { LiveStreamPlayer } from "@/components/common/LiveStreamPlayer";
import { Button } from "@/components/ui/button";
import { displaySeverity } from "@/lib/event-presentation";
import {
  effectiveCameraStatus,
  effectiveRecordingState,
  isCameraStale,
  recordingStateLabel,
} from "@/lib/health";
import type { NormalizedBox } from "@/lib/subject-locate";
import type { StreamReadiness } from "@/lib/stream-health";

import { SubjectLocateOverlay } from "./SubjectLocateOverlay";
import { LiveAlertOverlay } from "./LiveAlertOverlay";
import { cn } from "@/lib/utils";
import { viewportReadinessBadge } from "@/lib/live-monitoring";
import type { EventAttributionDisplay } from "@/lib/attribution-state";
import type { AiRule, Camera, DetectionEvent, NvrStatus } from "@/types";

/**
 * The viewport renders the annotated MJPEG stream from the Python AI service.
 * When that stream is unavailable it shows a waiting state — it never renders a
 * stand-in image, simulated detections or an invented recording indicator.
 */
export function MainMonitoringViewport({
  camera,
  event,
  eventAttribution,
  readiness,
  locate,
  locateStatus,
}: {
  camera: Camera;
  /** Only a currently active (non-expired) alert event, or undefined. */
  event?: DetectionEvent;
  /** Truthful anonymous subject presentation for the active alert event. */
  eventAttribution?: EventAttributionDisplay;
  /** The ONE shared measured stream-readiness decision for this camera. */
  readiness: StreamReadiness;
  /** Verified highlight for one located anonymous subject, or null. */
  locate?: { box: NormalizedBox; label: string } | null;
  /** Truthful locate wording shown even when no position can be drawn. */
  locateStatus?: string | null;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const onImageSize = useCallback(
    (size: { width: number; height: number } | null) => setImageSize(size),
    [],
  );
  const fullscreen = () => {
    void frameRef.current?.requestFullscreen();
  };
  const stale = isCameraStale(camera);

  // Viewport, HUD and stream player share ONE truth: the stream is only called
  // live while the AI service currently measures fresh annotated frames.
  const live = readiness.displayable;
  const badge = viewportReadinessBadge(readiness);
  return (
    <div
      ref={frameRef}
      className={cn(
        "relative min-h-0 flex-1 overflow-hidden border border-primary/35 bg-background",
        event &&
          displaySeverity(event) === "critical" &&
          "animate-alert-frame border-destructive/70",
      )}
    >
      <div className="hud-grid absolute inset-0 grid place-items-center">
        <LiveStreamPlayer cameraId={camera.id} readiness={readiness} onImageSize={onImageSize} />
      </div>
      {/* Only a verified, currently observed subject is ever highlighted, and
          only while a fresh stream is actually on screen. */}
      {locate && live && (
        <SubjectLocateOverlay box={locate.box} label={locate.label} image={imageSize} />
      )}
      {/* HUD zone: below the top-left AI badge, so it can never collide with the
          temporary top-center live alert. */}
      {locateStatus && (
        <div className="pointer-events-none absolute left-5 top-16 z-40 max-w-[min(60%,320px)] truncate border border-warning/60 bg-background/88 px-2 py-1 font-mono text-[9px] uppercase text-warning backdrop-blur-sm">
          {locateStatus}
        </div>
      )}

      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 animate-surveillance-scan"
        style={{ background: "var(--scan-line)" }}
      />
      <span className="pointer-events-none absolute left-3 top-3 z-20 size-9 border-l-2 border-t-2 border-primary/70" />
      <span className="pointer-events-none absolute right-3 top-3 z-20 size-9 border-r-2 border-t-2 border-primary/70" />
      <span className="pointer-events-none absolute bottom-3 left-3 z-20 size-9 border-b-2 border-l-2 border-primary/70" />
      <span className="pointer-events-none absolute bottom-3 right-3 z-20 size-9 border-b-2 border-r-2 border-primary/70" />
      <LiveAlertOverlay
        {...(event ? { event } : {})}
        {...(eventAttribution ? { attribution: eventAttribution } : {})}
        camera={camera}
      />
      <div className="absolute left-5 top-5 z-40 flex items-center gap-2 border border-primary/40 bg-background/82 px-2 py-1.5 backdrop-blur-sm">
        <span
          className={cn(
            "size-1.5 rounded-full",
            camera.aiEnabled && live ? "animate-pulse-dot bg-primary" : "bg-muted-foreground",
          )}
        />
        <span className="font-mono text-[9px] text-primary">
          {!camera.aiEnabled
            ? "AI ANALYSIS OFF"
            : live
              ? "AI ANALYSIS ENABLED"
              : "AI ANALYSIS ENABLED · NO LIVE FRAMES"}
        </span>
      </div>

      <div className="absolute right-5 top-5 z-40 flex gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-8 bg-background/80"
          onClick={fullscreen}
          aria-label="Open full screen"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
      {/* HUD zone bottom-left: camera identity + the ONE measured LIVE claim. */}
      <div className="absolute bottom-5 left-5 z-40 max-w-[calc(100%-2.5rem)] border border-border bg-background/82 px-3 py-1.5 backdrop-blur-sm sm:max-w-[60%]">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[9px]">
          <span className="shrink-0 text-primary">CH{String(camera.channel).padStart(2, "0")}</span>
          <span className="truncate text-foreground">{camera.name}</span>
          <span className="hidden truncate text-muted-foreground sm:inline">{camera.location}</span>
          {/* The only LIVE claim in the HUD: measured stream readiness. */}
          <span
            className={cn(
              "shrink-0",
              badge.tone === "success" && "text-success",
              badge.tone === "warning" && "text-warning",
              badge.tone === "error" && "text-destructive",
              badge.tone === "muted" && "text-muted-foreground",
            )}
          >
            {badge.text}
          </span>
        </div>
      </div>
      {/* HUD zone bottom-right: lowest-priority metadata, reduced first on small
          viewports so it can never overlap identity/status or Locate wording. */}
      <div className="absolute bottom-5 right-5 z-40 hidden items-center gap-3 border border-primary/40 bg-background/82 px-3 py-1.5 font-mono text-[9px] backdrop-blur-sm sm:flex">
        <span
          className={cn(
            "flex items-center gap-1",
            camera.aiEnabled ? "text-primary" : "text-muted-foreground",
          )}
        >
          <Cpu className="size-3" /> AI
        </span>
        <span className="hidden md:inline">{camera.resolution}</span>
        <span>{stale ? "— FPS" : `${camera.fps} FPS`}</span>
        {camera.isDemo && <span className="text-warning">DEMO SOURCE</span>}
      </div>

    </div>
  );
}

export function CameraHealthStrip({
  camera,
  rule,
  event,
  nvr,
}: {
  camera: Camera;
  rule?: AiRule;
  event?: DetectionEvent;
  nvr?: NvrStatus;
}) {
  // Recording is only claimed when the camera record and the NVR heartbeat
  // agree; unknown heartbeat state is reported as unknown, never as active.
  const recording = effectiveRecordingState(camera, nvr);
  const cameraStatus = effectiveCameraStatus(camera);
  return (
    <div className="grid h-10 shrink-0 grid-cols-3 border border-t-0 border-border bg-surface sm:grid-cols-6">
      <Health
        label="Camera"
        value={cameraStatus}
        tone={cameraStatus === "online" ? "ok" : "warn"}
      />
      <Health
        label="AI rule"
        value={rule?.name ?? "None enabled"}
        {...(rule ? { tone: "ok" as const } : {})}
      />
      <Health label="AI analysis" value={camera.aiEnabled ? "Enabled" : "Off"} />
      <Health
        label="Trigger conf."
        value={
          event?.triggerConfidence != null ? `${Math.round(event.triggerConfidence * 100)}%` : "—"
        }
      />
      <Health
        label="Recording"
        value={recordingStateLabel[recording]}
        tone={recording === "active" ? "ok" : "warn"}
      />
      <Health
        label="Last alert"
        value={event ? "Reported" : "None"}
        {...(event ? { tone: "critical" as const } : {})}
      />
    </div>
  );
}

function Health({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "critical";
}) {
  return (
    <div className="min-w-0 border-r border-border/70 px-2 py-1">
      <p className="truncate font-mono text-[7px] uppercase text-muted-foreground">{label}</p>
      <p
        className={cn(
          "truncate font-mono text-[9px] uppercase text-foreground",
          tone === "ok" && "text-success",
          tone === "warn" && "text-warning",
          tone === "critical" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Bounded camera wall. At most MAX_WALL_STREAMS cameras are RENDERED at a time,
 * so the browser can never open more simultaneous MJPEG connections than that.
 * Cameras outside the current page are not mounted at all — no hidden players,
 * no display:none preloading — so their stream lifecycles cancel through the
 * existing LiveStreamPlayer/proxy cancellation path.
 */
export function CameraWall({
  cameras,
  onSelect,
  readinessFor,
  page,
  onPageChange,
}: {
  cameras: Camera[];
  onSelect: (camera: Camera) => void;
  /** One shared page-level health result; each tile decides for itself. */
  readinessFor: (cameraId: string) => StreamReadiness;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const pageCount = wallPageCount(cameras.length);
  const current = clampWallPage(page, cameras.length);
  const visible = wallPageCameras(cameras, current);
  if (cameras.length === 0)
    return (
      <div className="grid min-h-0 flex-1 place-items-center border border-border bg-surface/40 font-mono text-[10px] uppercase text-muted-foreground">
        No cameras configured
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-1 p-1",
          visible.length === 1
            ? "grid-cols-1"
            : visible.length === 2
              ? "grid-cols-1 sm:grid-cols-2"
              : "grid-cols-1 sm:grid-cols-2 sm:grid-rows-2",
        )}
      >
        {visible.map((camera) => {
          const readiness = readinessFor(camera.id);
          return (
            <button
              key={camera.id}
              type="button"
              onClick={() => onSelect(camera)}
              className="group relative min-h-0 overflow-hidden border border-border bg-surface text-left"
            >
              <div className="hud-grid absolute inset-0 grid place-items-center">
                <LiveStreamPlayer cameraId={camera.id} readiness={readiness} />
              </div>
              <div className="absolute inset-x-0 bottom-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 bg-background/85 px-2 py-1 font-mono text-[9px]">
                <span className="truncate">
                  CH{String(camera.channel).padStart(2, "0")} · {camera.name}
                </span>
                <span className={readiness.displayable ? "text-success" : "text-destructive"}>
                  {readiness.displayable ? "LIVE" : readiness.label}
                </span>
              </div>
              <Grid2X2 className="absolute right-2 top-2 size-3.5 text-primary" />
            </button>
          );
        })}
      </div>
      {pageCount > 1 && (
        <div className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-surface px-2 font-mono text-[9px]">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-[9px]"
            disabled={current <= 1}
            onClick={() => onPageChange(current - 1)}
            aria-label="Previous wall page"
          >
            <ChevronLeft className="size-3" /> PREVIOUS
          </Button>
          <span className="text-muted-foreground">
            PAGE {current} / {pageCount} · {visible.length} OF {cameras.length} CAMERAS LIVE
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-[9px]"
            disabled={current >= pageCount}
            onClick={() => onPageChange(current + 1)}
            aria-label="Next wall page"
          >
            NEXT <ChevronRight className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );

}

