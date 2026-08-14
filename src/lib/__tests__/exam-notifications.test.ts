import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALERT_TYPE_LABELS,
  DELIVERY_DISCLAIMER,
  DELIVERY_STATUS_VALUE,
  EXAM_NOTIFICATION_ROLES,
  EXAM_NOTIFICATION_ROLE_LABELS,
  HUMAN_REVIEW_LINE,
  PREVIEW_CAMERA_LABEL,
  checkRecipientPhone,
  emptyExamNotificationDraft,
  formatExamNotificationPreview,
  recipientPreviewRows,
} from "@/lib/exam-notifications";

const CONTEXT = {
  examTitle: "Data Structures Midterm",
  courseCode: "CS201",
  location: "Hall A",
  cameraLabel: PREVIEW_CAMERA_LABEL,
};

const panelSource = readFileSync("src/components/exams/ExamNotificationsPanel.tsx", "utf8");
const helperSource = readFileSync("src/lib/exam-notifications.ts", "utf8");
const newUiSource = `${panelSource}\n${helperSource}`;

describe("exam notification recipients", () => {
  it("A. exposes exactly the Exam Doctor and Head of Department roles", () => {
    expect([...EXAM_NOTIFICATION_ROLES]).toEqual(["doctor", "headOfDepartment"]);
    expect(Object.values(EXAM_NOTIFICATION_ROLE_LABELS)).toEqual([
      "Exam Doctor",
      "Head of Department",
    ]);
    const rows = recipientPreviewRows(emptyExamNotificationDraft());
    expect(rows.map((row) => row.roleLabel)).toEqual(["Exam Doctor", "Head of Department"]);
  });

  it("B. requires a phone number for an enabled recipient with an empty value", () => {
    const check = checkRecipientPhone({ fullName: "Dr. Ahmad", phone: "  ", enabled: true });
    expect(check).toEqual({ kind: "required", message: "Phone number required" });
    const rows = recipientPreviewRows(emptyExamNotificationDraft());
    expect(rows[0]!.status).toBe("phone_required");
    expect(rows[0]!.statusLabel).toBe("Phone number required");
  });

  it("B2. a disabled recipient needs no phone number and reads Disabled", () => {
    expect(checkRecipientPhone({ fullName: "", phone: "", enabled: false }).kind).toBe("ok");
    const draft = emptyExamNotificationDraft();
    draft.doctor.enabled = false;
    expect(recipientPreviewRows(draft)[0]!.statusLabel).toBe("Disabled");
  });

  it("C. accepts a valid-looking international phone format", () => {
    for (const phone of ["+962 79 123 4567", "+962791234567", "079-123-4567"]) {
      expect(checkRecipientPhone({ fullName: "Dr. Ahmad", phone, enabled: true }).kind).toBe("ok");
    }
    for (const phone of ["12", "+", "not a phone"]) {
      expect(checkRecipientPhone({ fullName: "Dr. Ahmad", phone, enabled: true }).kind).toBe(
        "invalid",
      );
    }
  });

  it("7. recipient preview never reports a delivery state", () => {
    const rows = recipientPreviewRows(emptyExamNotificationDraft());
    const text = rows.map((row) => row.statusLabel).join(" ");
    for (const forbidden of ["Sent", "Delivered", "Read", "Queued", "Retrying"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("exam notification message preview", () => {
  it("D. mobile phone preview shows the alert, the anonymous subject and review wording", () => {
    const lines = formatExamNotificationPreview("mobile_phone", CONTEXT);
    expect(lines[0]).toBe("Vigilant Eye");
    expect(lines).toContain("Mobile Phone Detected");
    expect(lines).toContain("Subject S017");
    expect(lines).toContain(HUMAN_REVIEW_LINE);
  });

  it("E. paper exchange preview shows the subject pair and review wording", () => {
    const lines = formatExamNotificationPreview("paper_exchange", CONTEXT);
    expect(lines).toContain("Possible Paper Exchange");
    expect(lines.join("\n")).toContain("S017 ↔ S043");
    expect(lines).toContain(HUMAN_REVIEW_LINE);
  });

  it("11. reuses real exam session metadata and a labelled camera placeholder", () => {
    const text = formatExamNotificationPreview("mobile_phone", CONTEXT).join("\n");
    expect(text).toContain("Data Structures Midterm");
    expect(text).toContain("CS201");
    expect(text).toContain("Hall A");
    expect(text).toContain("preview placeholder");
  });

  it("F. never contains raw tracker id wording", () => {
    const text = [
      ...formatExamNotificationPreview("mobile_phone", CONTEXT),
      ...formatExamNotificationPreview("paper_exchange", CONTEXT),
    ].join("\n");
    for (const forbidden of ["Person ID", "TRACK", "trackingId", "tracking id", "face"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("G. never contains accusatory cheating language", () => {
    const text = [
      ...formatExamNotificationPreview("mobile_phone", CONTEXT),
      ...formatExamNotificationPreview("paper_exchange", CONTEXT),
    ]
      .join("\n")
      .toLowerCase();
    for (const forbidden of ["confirmed cheating", "cheated", "cheater", "cheating"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("exam notifications frontend-only contract", () => {
  it("H. exposes no send or test control", () => {
    for (const forbidden of [
      "Send notification",
      "Send WhatsApp",
      "Test WhatsApp",
      "Send test",
      "sendMessage",
    ]) {
      expect(newUiSource).not.toContain(forbidden);
    }
  });

  it("I. states that delivery is not connected and the values are preview only", () => {
    expect(DELIVERY_STATUS_VALUE).toBe("Not connected");
    expect(DELIVERY_DISCLAIMER).toBe("Preview only · No messages are sent");
    expect(panelSource).toContain("DELIVERY_DISCLAIMER");
    expect(panelSource).toContain("DELIVERY_STATUS_VALUE");
    // The disclaimer is rendered unconditionally: no state guards it.
    expect(panelSource).not.toMatch(/&&\s*\{?\s*DELIVERY_DISCLAIMER/);
  });

  it("J. performs no Supabase write and calls no notification backend", () => {
    for (const forbidden of [
      "@/integrations/supabase",
      "createServerFn",
      "useServerFn",
      "useMutation",
      "fetch(",
      "/api/",
    ]) {
      expect(newUiSource).not.toContain(forbidden);
    }
  });

  it("K. alert switches only touch the local draft, never AI rules", () => {
    expect(ALERT_TYPE_LABELS.mobilePhone).toBe("Notify on Mobile Phone Detected");
    expect(ALERT_TYPE_LABELS.paperExchange).toBe("Notify on Possible Paper Exchange");
    for (const forbidden of ["useAiRules", "aiRule", "ai_rules", "updateRule"]) {
      expect(newUiSource).not.toContain(forbidden);
    }
    const draft = emptyExamNotificationDraft();
    const toggled = { ...draft, mobilePhoneEnabled: false };
    expect(draft.mobilePhoneEnabled).toBe(true);
    expect(toggled.mobilePhoneEnabled).toBe(false);
  });

  it("L. does not present Telegram as an operator-facing notification channel", () => {
    expect(newUiSource.toLowerCase()).not.toContain("telegram");
    const settings = readFileSync("src/routes/_authenticated/settings.tsx", "utf8");
    expect(settings.toLowerCase()).not.toContain("telegram");
  });
});
