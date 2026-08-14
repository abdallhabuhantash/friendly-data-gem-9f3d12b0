import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { VideoOff } from "lucide-react";
import { useEffect, useState } from "react";
import { createStreamTicket } from "@/lib/stream-ticket.functions";

/**
 * Renders the annotated MJPEG stream produced by the Python AI service.
 * The browser only ever talks to the app's own proxy route, never to the
 * camera or NVR.
 */
export function LiveStreamPlayer({
  cameraId,
  offline,
  onImageSize,
}: {
  cameraId: string;
  offline: boolean;
  /** Real intrinsic frame size, needed to place overlays over an object-cover image. */
  onImageSize?: (size: { width: number; height: number } | null) => void;
}) {
  const issueTicket = useServerFn(createStreamTicket);
  const [failed, setFailed] = useState(false);

  // A failed stream must not stick to the next camera, and a camera that comes
  // back online gets another attempt instead of staying blank forever.
  useEffect(() => {
    setFailed(false);
    // A stale frame size would misplace an overlay on the next camera.
    onImageSize?.(null);
  }, [cameraId, offline, onImageSize]);

  const ticket = useQuery({
    queryKey: ["stream-ticket", cameraId],
    queryFn: () => issueTicket({ data: { cameraId } }),
    enabled: !offline,
    refetchInterval: 4 * 60_000,
    retry: false,
  });

  if (offline || failed || ticket.isError || !ticket.data) {
    return (
      <div className="flex flex-col items-center gap-1 text-muted-foreground">
        <VideoOff className="size-6" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em]">
          {offline ? "No signal" : "Awaiting AI service"}
        </span>
      </div>
    );
  }

  return (
    <img
      src={`/api/stream/${cameraId}?t=${encodeURIComponent(ticket.data.ticket)}`}
      alt="Annotated live camera stream with AI detection overlays"
      className="absolute inset-0 size-full object-cover"
      onLoad={(event) => {
        const target = event.currentTarget;
        onImageSize?.(
          target.naturalWidth > 0 && target.naturalHeight > 0
            ? { width: target.naturalWidth, height: target.naturalHeight }
            : null,
        );
      }}
      onError={() => {
        setFailed(true);
        onImageSize?.(null);
      }}
    />
  );
}
