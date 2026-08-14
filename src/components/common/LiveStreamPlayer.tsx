import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { VideoOff } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { createStreamTicket } from "@/lib/stream-ticket.functions";
import type { StreamReadiness } from "@/lib/stream-health";
import {
  initialStreamConnection,
  shouldOpenNow,
  streamConnectionReducer,
} from "@/lib/stream-connection";

/**
 * Renders the annotated MJPEG stream produced by the Python AI service.
 *
 * The browser only ever talks to the app's own proxy route, never to the camera
 * or NVR. The image is mounted ONLY while measured stream health proves the
 * camera is connected and currently publishing fresh annotated frames, so a
 * frozen last frame can never survive as a "live" picture.
 */
export function LiveStreamPlayer({
  cameraId,
  readiness,
  onImageSize,
}: {
  cameraId: string;
  /** Shared page-level readiness decision. The player never invents its own. */
  readiness: StreamReadiness;
  /** Real intrinsic frame size, needed to place overlays over an object-cover image. */
  onImageSize?: (size: { width: number; height: number } | null) => void;
}) {
  const issueTicket = useServerFn(createStreamTicket);
  const [connection, dispatch] = useReducer(
    streamConnectionReducer,
    cameraId,
    initialStreamConnection,
  );
  const ready = readiness.displayable;

  // Authorization renewal stays on its own clock. The renewed ticket is kept
  // aside for the NEXT incarnation and never rewrites a healthy image's src.
  const ticket = useQuery({
    queryKey: ["stream-ticket", cameraId],
    queryFn: () => issueTicket({ data: { cameraId } }),
    enabled: ready || connection.activeTicket !== null,
    refetchInterval: 4 * 60_000,
    retry: false,
  });
  const latestTicket = ticket.data?.ticket ?? null;
  const latestTicketRef = useRef<string | null>(null);
  latestTicketRef.current = latestTicket;

  // A camera switch (or unmount) cancels the whole previous lifecycle.
  useEffect(() => {
    dispatch({ type: "camera", cameraId });
  }, [cameraId]);

  // Authorization failure fails closed, exactly like a lost stream.
  const authorizationFailed = ticket.isError;

  useEffect(() => {
    if (!ready || authorizationFailed) {
      dispatch({ type: "unready" });
      return;
    }
    const available = latestTicketRef.current;
    if (!available) return;
    if (shouldOpenNow(connection, true)) {
      dispatch({ type: "open", ticket: available });
      return;
    }
    if (connection.retryPending && connection.retryDelayMs !== null) {
      // Bounded backoff. The timer is bound to this camera + incarnation, so
      // switching cameras cancels it and it can never replace the new stream.
      const timer = setTimeout(() => {
        const fresh = latestTicketRef.current;
        if (fresh) dispatch({ type: "open", ticket: fresh });
      }, connection.retryDelayMs);
      return () => clearTimeout(timer);
    }
    return;
  }, [ready, authorizationFailed, connection, latestTicket]);

  const mountedTicket = ready && !authorizationFailed ? connection.activeTicket : null;

  // No mounted stream means no intrinsic size either: stale dimensions would
  // misplace a Locate overlay over an object-cover image.
  useEffect(() => {
    if (mountedTicket === null) onImageSize?.(null);
  }, [mountedTicket, onImageSize]);

  if (mountedTicket === null) {
    return (
      <div className="flex flex-col items-center gap-1 text-muted-foreground">
        <VideoOff className="size-6" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em]">
          {authorizationFailed ? "STREAM AUTHORIZATION UNAVAILABLE" : readiness.label}
        </span>
      </div>
    );
  }

  return (
    <img
      key={`${cameraId}:${connection.incarnation}`}
      src={`/api/stream/${cameraId}?t=${encodeURIComponent(mountedTicket)}`}
      alt="Annotated live camera stream with AI detection overlays"
      className="absolute inset-0 size-full object-cover"
      onLoad={(event) => {
        const target = event.currentTarget;
        dispatch({ type: "loaded" });
        onImageSize?.(
          target.naturalWidth > 0 && target.naturalHeight > 0
            ? { width: target.naturalWidth, height: target.naturalHeight }
            : null,
        );
      }}
      onError={() => {
        dispatch({ type: "error" });
        onImageSize?.(null);
      }}
    />
  );
}
