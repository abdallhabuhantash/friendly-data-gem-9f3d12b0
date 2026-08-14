/**
 * Frontend-only Exam Notifications configuration and message preview.
 *
 * There is NO delivery in this phase: nothing here talks to WhatsApp,
 * SMS, email, a queue, a worker or any server endpoint. The draft below lives in
 * component state only and is never written to the database, so no Supabase
 * types are extended and no migration exists.
 *
 * The preview follows the existing anonymous subject contract: only `Sxxx`
 * labels are ever rendered, never a raw tracker id, and the wording stays
 * advisory ("Requires Human Review") instead of accusatory.
 */

/** The two recipient roles this phase supports, in presentation order. */
export const EXAM_NOTIFICATION_ROLES = ["doctor", "headOfDepartment"] as const;

export type ExamNotificationRole = (typeof EXAM_NOTIFICATION_ROLES)[number];

export const EXAM_NOTIFICATION_ROLE_LABELS: Record<ExamNotificationRole, string> = {
  doctor: "Exam Doctor",
  headOfDepartment: "Head of Department",
};

/** International-format hint only. It is never checked against a real service. */
export const PHONE_PLACEHOLDER = "+962 7X XXX XXXX";

export interface ExamNotificationRecipientDraft {
  fullName: string;
  /** Frontend value only in this phase; never persisted, never dialled. */
  phone: string;
  enabled: boolean;
}

export type ExamNotificationPreviewType = "mobile_phone" | "paper_exchange";

export interface ExamNotificationDraft {
  doctor: ExamNotificationRecipientDraft;
  headOfDepartment: ExamNotificationRecipientDraft;
  mobilePhoneEnabled: boolean;
  paperExchangeEnabled: boolean;
  previewType: ExamNotificationPreviewType;
}

const emptyRecipient = (): ExamNotificationRecipientDraft => ({
  fullName: "",
  phone: "",
  enabled: true,
});

export function emptyExamNotificationDraft(): ExamNotificationDraft {
  return {
    doctor: emptyRecipient(),
    headOfDepartment: emptyRecipient(),
    mobilePhoneEnabled: true,
    paperExchangeEnabled: true,
    previewType: "mobile_phone",
  };
}

/** The permanent, non-dismissable truthfulness disclaimer. */
export const DELIVERY_STATUS_LABEL = "WHATSAPP DELIVERY";
export const DELIVERY_STATUS_VALUE = "Not connected";
export const DELIVERY_DISCLAIMER = "Preview only · No messages are sent";

/** Advisory closing line required in every preview. */
export const HUMAN_REVIEW_LINE = "Requires Human Review";

/**
 * Lightweight frontend phone shape check. It permits a single leading `+` plus
 * digits and common separators and rejects obviously too-short values. It
 * deliberately proves nothing about whether the number exists on WhatsApp.
 */
export type PhoneCheck =
  | { kind: "ok" }
  | { kind: "required"; message: string }
  | { kind: "invalid"; message: string };

const PHONE_SHAPE = /^\+?[0-9 ()./-]+$/;

export function checkRecipientPhone(recipient: ExamNotificationRecipientDraft): PhoneCheck {
  const value = recipient.phone.trim();
  if (!recipient.enabled) return { kind: "ok" };
  if (value === "") return { kind: "required", message: "Phone number required" };
  if (!PHONE_SHAPE.test(value)) {
    return { kind: "invalid", message: "Use digits with an optional leading +" };
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) {
    return { kind: "invalid", message: "Phone number looks incomplete" };
  }
  return { kind: "ok" };
}

export interface RecipientPreviewRow {
  role: ExamNotificationRole;
  roleLabel: string;
  /** Who the message would be addressed to, if a name was entered. */
  name: string | null;
  phone: string | null;
  /** Never a delivery state: this phase has no Sent/Delivered/Queued concept. */
  status: "included" | "disabled" | "phone_required" | "phone_invalid";
  statusLabel: string;
}

const STATUS_LABELS: Record<RecipientPreviewRow["status"], string> = {
  included: "Intended recipient",
  disabled: "Disabled",
  phone_required: "Phone number required",
  phone_invalid: "Check phone number",
};

function recipientRow(
  role: ExamNotificationRole,
  recipient: ExamNotificationRecipientDraft,
): RecipientPreviewRow {
  const check = checkRecipientPhone(recipient);
  const status: RecipientPreviewRow["status"] = !recipient.enabled
    ? "disabled"
    : check.kind === "required"
      ? "phone_required"
      : check.kind === "invalid"
        ? "phone_invalid"
        : "included";
  const name = recipient.fullName.trim();
  const phone = recipient.phone.trim();
  return {
    role,
    roleLabel: EXAM_NOTIFICATION_ROLE_LABELS[role],
    name: name === "" ? null : name,
    phone: phone === "" ? null : phone,
    status,
    statusLabel: STATUS_LABELS[status],
  };
}

/** Intended recipients only — never a delivery report. */
export function recipientPreviewRows(draft: ExamNotificationDraft): RecipientPreviewRow[] {
  return [
    recipientRow("doctor", draft.doctor),
    recipientRow("headOfDepartment", draft.headOfDepartment),
  ];
}

export interface ExamNotificationPreviewContext {
  /** Real exam session metadata when the page already has it. */
  examTitle: string;
  courseCode: string | null;
  location: string | null;
  /** Clearly labelled placeholder: this screen owns no camera relationship. */
  cameraLabel: string;
}

/** Placeholder camera used by the configuration screen's preview. */
export const PREVIEW_CAMERA_LABEL = "Camera 01 (preview placeholder)";

/** Representative anonymous subjects for the two preview shapes. */
export const PREVIEW_SUBJECT = "S017";
export const PREVIEW_SUBJECT_PAIR = "S017 ↔ S043";

/**
 * Pure formatter for the future WhatsApp message shape. It never reads events,
 * never queries the database and never returns a delivery status.
 */
export function formatExamNotificationPreview(
  type: ExamNotificationPreviewType,
  context: ExamNotificationPreviewContext,
): string[] {
  const lines: string[] = ["Vigilant Eye"];
  if (type === "mobile_phone") {
    lines.push("Mobile Phone Detected", `Subject ${PREVIEW_SUBJECT}`);
  } else {
    lines.push("Possible Paper Exchange", `Subjects ${PREVIEW_SUBJECT_PAIR}`);
  }
  const title = context.courseCode
    ? `${context.examTitle} · ${context.courseCode}`
    : context.examTitle;
  lines.push(title);
  const place = [context.location, context.cameraLabel].filter(Boolean).join(" · ");
  if (place) lines.push(place);
  if (type === "mobile_phone") lines.push("Confidence: 94% (example)");
  lines.push(HUMAN_REVIEW_LINE);
  return lines;
}

export const PREVIEW_TYPE_LABELS: Record<ExamNotificationPreviewType, string> = {
  mobile_phone: "Preview Mobile Phone Message",
  paper_exchange: "Preview Paper Exchange Message",
};

/** Wording for the two frontend-only alert-type switches. */
export const ALERT_TYPE_LABELS = {
  mobilePhone: "Notify on Mobile Phone Detected",
  paperExchange: "Notify on Possible Paper Exchange",
} as const;
