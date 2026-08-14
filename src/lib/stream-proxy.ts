/**
 * Downstream → upstream MJPEG cancellation plumbing for the stream proxy.
 *
 * The body is never buffered: the upstream stream is handed straight to the
 * response. The only added behaviour is that a downstream disconnect (camera
 * switch, unmount, navigation, closed tab) cancels the upstream body so no
 * orphaned Python MJPEG request is left running.
 */

export interface UpstreamStream {
  body: { cancel(): Promise<unknown> } | null;
  ok: boolean;
  contentType: string | null;
}

export const MJPEG_FALLBACK_CONTENT_TYPE = "multipart/x-mixed-replace; boundary=frame";

export type ProxyDecision =
  | { kind: "unavailable" }
  | { kind: "cancelled" }
  | { kind: "stream"; contentType: string };

/**
 * Decides what to do with an upstream MJPEG response and binds its lifetime to
 * the downstream signal. Returns the streaming decision; the caller builds the
 * `Response` with the (still un-buffered) upstream body.
 */
export function bindUpstreamToDownstream(
  upstream: UpstreamStream,
  signal: { aborted: boolean; addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void },
): ProxyDecision {
  const body = upstream.body;
  if (!upstream.ok || !body) return { kind: "unavailable" };
  if (signal.aborted) {
    void body.cancel().catch(() => {});
    return { kind: "cancelled" };
  }
  signal.addEventListener(
    "abort",
    () => {
      void body.cancel().catch(() => {});
    },
    { once: true },
  );
  return { kind: "stream", contentType: upstream.contentType ?? MJPEG_FALLBACK_CONTENT_TYPE };
}
