import { useMemo, useState } from "react";
import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ALERT_TYPE_LABELS,
  DELIVERY_DISCLAIMER,
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_VALUE,
  EXAM_NOTIFICATION_ROLE_LABELS,
  PHONE_PLACEHOLDER,
  PREVIEW_CAMERA_LABEL,
  PREVIEW_TYPE_LABELS,
  checkRecipientPhone,
  emptyExamNotificationDraft,
  formatExamNotificationPreview,
  recipientPreviewRows,
} from "@/lib/exam-notifications";
import type {
  ExamNotificationDraft,
  ExamNotificationRecipientDraft,
  ExamNotificationRole,
} from "@/lib/exam-notifications";
import type { ExamSession } from "@/types";

/**
 * Frontend-only Exam Notifications experience for ONE exam session.
 *
 * Deliberate limitations, visible to the operator at all times:
 * - no delivery of any kind exists, so there is no send/test control;
 * - the entered values live in component state only and are never persisted;
 * - the alert-type switches only shape this preview and never touch AI rules,
 *   stored events or Live Monitoring.
 */
export function ExamNotificationsPanel({ session }: { session: ExamSession }) {
  const [draft, setDraft] = useState<ExamNotificationDraft>(emptyExamNotificationDraft);

  const patch = (role: ExamNotificationRole, values: Partial<ExamNotificationRecipientDraft>) =>
    setDraft((current) => ({ ...current, [role]: { ...current[role], ...values } }));

  const rows = recipientPreviewRows(draft);
  const previewLines = useMemo(
    () =>
      formatExamNotificationPreview(draft.previewType, {
        examTitle: session.title,
        courseCode: session.courseCode.trim() === "" ? null : session.courseCode,
        location: session.locationLabel.trim() === "" ? null : session.locationLabel,
        cameraLabel: PREVIEW_CAMERA_LABEL,
      }),
    [draft.previewType, session.title, session.courseCode, session.locationLabel],
  );

  return (
    <Panel
      title="Exam Notifications"
      subtitle="Configure who should receive exam alerts and preview the message format. Delivery integration is not connected in this build."
      actions={
        <div className="flex flex-col items-end">
          <span className="label-tech text-muted-foreground">{DELIVERY_STATUS_LABEL}</span>
          <span className="font-mono text-[11px] text-warning">{DELIVERY_STATUS_VALUE}</span>
        </div>
      }
      bodyClassName="grid gap-3 p-3 lg:grid-cols-2"
    >
      {/* Left: recipient configuration */}
      <div className="space-y-3">
        <p className="border border-warning/40 bg-warning/8 px-2 py-1 font-mono text-[10px] uppercase text-warning">
          {DELIVERY_DISCLAIMER}
        </p>
        {(["doctor", "headOfDepartment"] as const).map((role) => {
          const recipient = draft[role];
          const check = checkRecipientPhone(recipient);
          return (
            <div key={role} className="border border-border/70 bg-surface-2/40 p-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="label-tech text-foreground/80">
                  {EXAM_NOTIFICATION_ROLE_LABELS[role]}
                </span>
                <label className="flex items-center gap-2 font-mono text-[10px] uppercase text-muted-foreground">
                  {recipient.enabled ? "Alerts enabled" : "Alerts disabled"}
                  <Switch
                    checked={recipient.enabled}
                    onCheckedChange={(enabled) => patch(role, { enabled })}
                    aria-label={`Enable alerts for ${EXAM_NOTIFICATION_ROLE_LABELS[role]}`}
                  />
                </label>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input
                  value={recipient.fullName}
                  maxLength={100}
                  placeholder="Full name"
                  aria-label={`${EXAM_NOTIFICATION_ROLE_LABELS[role]} full name`}
                  onChange={(event) => patch(role, { fullName: event.target.value })}
                />
                <Input
                  value={recipient.phone}
                  maxLength={24}
                  inputMode="tel"
                  placeholder={PHONE_PLACEHOLDER}
                  aria-label={`${EXAM_NOTIFICATION_ROLE_LABELS[role]} WhatsApp phone number`}
                  onChange={(event) => patch(role, { phone: event.target.value })}
                />
              </div>
              {check.kind !== "ok" && (
                <p className="mt-1.5 font-mono text-[10px] text-destructive">{check.message}</p>
              )}
            </div>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          className="font-mono text-[10px]"
          onClick={() => setDraft(emptyExamNotificationDraft())}
        >
          Reset preview fields
        </Button>
      </div>

      {/* Right: alert types + message preview */}
      <div className="space-y-3">
        <div className="border border-border/70 bg-surface-2/40 p-2.5">
          <p className="label-tech text-foreground/80">Alert types</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            These switches shape this preview only. AI detection rules, stored events and Live
            Monitoring are not changed.
          </p>
          <label className="mt-2 flex items-center justify-between gap-3 text-xs text-foreground">
            {ALERT_TYPE_LABELS.mobilePhone}
            <Switch
              checked={draft.mobilePhoneEnabled}
              onCheckedChange={(value) =>
                setDraft((current) => ({ ...current, mobilePhoneEnabled: value }))
              }
              aria-label={ALERT_TYPE_LABELS.mobilePhone}
            />
          </label>
          <label className="mt-2 flex items-center justify-between gap-3 text-xs text-foreground">
            {ALERT_TYPE_LABELS.paperExchange}
            <Switch
              checked={draft.paperExchangeEnabled}
              onCheckedChange={(value) =>
                setDraft((current) => ({ ...current, paperExchangeEnabled: value }))
              }
              aria-label={ALERT_TYPE_LABELS.paperExchange}
            />
          </label>
        </div>

        <div className="border border-border/70 bg-surface-2/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="label-tech text-foreground/80">Message preview</p>
            <span className="border border-primary/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-primary">
              Preview
            </span>
          </div>
          <div className="mt-2 flex gap-1">
            {(["mobile_phone", "paper_exchange"] as const).map((type) => (
              <Button
                key={type}
                size="sm"
                variant={draft.previewType === type ? "secondary" : "ghost"}
                className="h-7 px-2 font-mono text-[9px]"
                onClick={() => setDraft((current) => ({ ...current, previewType: type }))}
              >
                {PREVIEW_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>
          <div className="mt-2 max-w-[320px] rounded-md rounded-bl-none border border-primary/30 bg-background/70 p-2.5">
            {previewLines.map((line, index) => (
              <p
                key={line}
                className={cn(
                  "text-[11px] text-foreground",
                  index === 0 && "font-mono text-[10px] uppercase text-primary",
                  index === 1 && "font-semibold",
                  line.startsWith("Requires") && "mt-1 text-warning",
                )}
              >
                {line}
              </p>
            ))}
          </div>
          <p className="mt-1.5 font-mono text-[9px] uppercase text-muted-foreground">
            Example content · not a stored event
          </p>
        </div>

        <div className="border border-border/70 bg-surface-2/40 p-2.5">
          <p className="label-tech text-foreground/80">Recipients</p>
          <ul className="mt-1.5 space-y-1">
            {rows.map((row) => (
              <li
                key={row.role}
                className="flex items-center justify-between gap-2 font-mono text-[10px]"
              >
                <span className="min-w-0 truncate text-foreground">
                  {row.status === "included" ? "✓" : "•"} {row.name ?? row.roleLabel}
                  {row.phone ? ` — ${row.phone}` : ""}
                </span>
                <span
                  className={cn(
                    "shrink-0 uppercase",
                    row.status === "included" ? "text-muted-foreground" : "text-warning",
                  )}
                >
                  {row.statusLabel}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Intended recipients only. Values are not saved and no message is sent, queued or
            delivered in this build.
          </p>
        </div>
      </div>
    </Panel>
  );
}
