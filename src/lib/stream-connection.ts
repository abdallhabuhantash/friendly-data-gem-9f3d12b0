/**
 * Pure lifecycle of ONE annotated MJPEG connection.
 *
 * Two separate concerns are kept apart on purpose:
 *
 *  - the ACTIVE CONNECTION TICKET, frozen into the mounted `<img src>`, and
 *  - the LATEST RENEWED TICKET, held outside this state.
 *
 * A background authorization renewal therefore never changes the `src` of a
 * healthy stream, while every *new* incarnation (transient reconnect, measured
 * recovery, camera re-selection) picks up the newest valid ticket.
 *
 * `incarnation` is monotonic per camera: an old camera's scheduled retry can be
 * recognised as stale and can never replace the camera the operator has since
 * selected.
 */

import { streamBackoffMs } from "./stream-health";

export interface StreamConnection {
  cameraId: string;
  /** Ticket bound to the mounted image; null means nothing is mounted. */
  activeTicket: string | null;
  /** Monotonic connection counter for this camera. */
  incarnation: number;
  /** Consecutive transport failures since the last successful frame. */
  attempt: number;
  /** A bounded reconnect is due; the delay is `retryDelayMs`. */
  retryPending: boolean;
  retryDelayMs: number | null;
  /** A real annotated image has decoded at least once for this incarnation. */
  loaded: boolean;
}

export type StreamAction =
  /** The operator selected another camera (or the player mounted). */
  | { type: "camera"; cameraId: string }
  /** Measured health is fresh and a ticket is available: open a connection. */
  | { type: "open"; ticket: string }
  /** A frame decoded successfully. */
  | { type: "loaded" }
  /** The `<img>` reported a transport error. */
  | { type: "error" }
  /** Measured health is no longer fresh (or authorization failed). */
  | { type: "unready" };

export function initialStreamConnection(cameraId: string): StreamConnection {
  return {
    cameraId,
    activeTicket: null,
    incarnation: 0,
    attempt: 0,
    retryPending: false,
    retryDelayMs: null,
    loaded: false,
  };
}

export function streamConnectionReducer(
  state: StreamConnection,
  action: StreamAction,
): StreamConnection {
  switch (action.type) {
    case "camera":
      // A camera switch cancels the whole previous lifecycle, including any
      // pending retry, and can never be resurrected.
      return state.cameraId === action.cameraId && state.incarnation === 0
        ? state
        : initialStreamConnection(action.cameraId);

    case "open":
      // A healthy, already mounted stream is never reopened.
      if (state.activeTicket !== null) return state;
      return {
        ...state,
        activeTicket: action.ticket,
        incarnation: state.incarnation + 1,
        retryPending: false,
        retryDelayMs: null,
        loaded: false,
      };

    case "loaded":
      if (state.activeTicket === null) return state;
      return { ...state, loaded: true, attempt: 0, retryPending: false, retryDelayMs: null };

    case "error": {
      if (state.activeTicket === null && !state.loaded && state.retryPending) return state;
      const attempt = state.attempt + 1;
      // The image is unmounted immediately: a frozen last frame must never stay.
      return {
        ...state,
        activeTicket: null,
        loaded: false,
        attempt,
        retryPending: true,
        retryDelayMs: streamBackoffMs(attempt),
      };
    }

    case "unready":
      // No hammering while health says the stream is not ready; wait for a
      // measured recovery instead.
      if (
        state.activeTicket === null &&
        !state.retryPending &&
        !state.loaded &&
        state.attempt === 0
      ) {
        return state;
      }
      return {
        ...state,
        activeTicket: null,
        loaded: false,
        attempt: 0,
        retryPending: false,
        retryDelayMs: null,
      };
  }
}

/** True when a new connection should be opened right now (no timer needed). */
export function shouldOpenNow(state: StreamConnection, ready: boolean): boolean {
  return ready && state.activeTicket === null && !state.retryPending;
}
