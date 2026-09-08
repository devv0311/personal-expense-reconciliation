"use client";

import { useRef, useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { evidenceTypeLabel } from "@/lib/labels";
import {
  useRecordEvidenceNote,
  useRecordEvidenceNotification,
  useUploadEvidenceFile,
} from "@/lib/queries";
import {
  EVIDENCE_DOCUMENT_TYPES,
  NOTIFICATION_EVIDENCE_TYPES,
  type EvidenceNoteKind,
  type EvidenceType,
  type NotificationEvidenceType,
} from "@/lib/types";

/**
 * The three ways evidence gets into this ledger by hand: a document, a typed note, and the
 * text of a bank or UPI notification.
 *
 * They are three controls rather than one because they are three different kinds of record.
 * A **document** is bytes with a content hash. A **note** is a person's own account of
 * something — and a `settlement_claim` note is evidence of a *belief*, never a settlement and
 * never a payment: recording "Alex says he paid me" must not move a balance. A
 * **notification** is immutable source text that a deterministic parser reads a structured
 * observation off, which is what later makes an evidence↔payment match explainable.
 *
 * Nothing here links anything to anything. Ingesting a document and deciding what it is about
 * are separate acts, and the second one is write-once (ADR-0034).
 */
export function EvidenceIntake() {
  const [open, setOpen] = useState<"file" | "note" | "notification" | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setOpen("file")}>
        Upload a document
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("note")}>
        Write a note
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("notification")}>
        Paste a notification
      </Button>

      {open === "file" && <UploadDialog onClose={() => setOpen(null)} />}
      {open === "note" && <NoteDialog onClose={() => setOpen(null)} />}
      {open === "notification" && <NotificationDialog onClose={() => setOpen(null)} />}
    </div>
  );
}

function UploadDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<EvidenceType>("receipt_image");
  const [capturedOn, setCapturedOn] = useState(toDateInputValue(new Date()));
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useUploadEvidenceFile();

  return (
    <DecisionDialog
      open
      onClose={onClose}
      title="Upload a document"
      consequence={
        <>
          This stores the file itself, addressed by the hash of its contents, and records an
          evidence row pointing at it. Uploading the same bytes twice is recognised rather than
          stored twice. It attaches the document to nothing — saying what it is about is a separate,
          permanent decision.
        </>
      }
      confirmLabel="Store it"
      confirmDisabled={file === null}
      reasonLabel="Note for the audit trail"
      pending={upload.isPending}
      error={upload.error}
      onConfirm={(reason) => {
        if (file === null) return;
        upload.mutate(
          {
            file,
            type,
            capturedAt: fromDateInputValue(capturedOn),
            ...(reason === undefined ? {} : { reason }),
          },
          {
            onSuccess: () => {
              setFile(null);
              if (fileInput.current !== null) fileInput.current.value = "";
              onClose();
            },
          },
        );
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-type">What it is</Label>
          <Select
            id="evidence-type"
            value={type}
            onChange={(event) => setType(event.target.value as EvidenceType)}
          >
            {EVIDENCE_DOCUMENT_TYPES.map((option) => (
              <option key={option} value={option}>
                {evidenceTypeLabel(option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-captured">When it was captured</Label>
          <Input
            id="evidence-captured"
            type="date"
            value={capturedOn}
            onChange={(event) => setCapturedOn(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-file">File</Label>
          <input
            ref={fileInput}
            id="evidence-file"
            type="file"
            className="text-body text-ink file:mr-3 file:rounded-sm file:border file:border-rule file:bg-panel file:px-3 file:py-1.5 file:text-meta file:text-ink"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <p className="text-micro text-ink-faint">
            Images and PDFs. The file stays on this machine; nothing about it is sent anywhere else.
          </p>
        </div>
      </div>
    </DecisionDialog>
  );
}

function NoteDialog({ onClose }: { onClose: () => void }) {
  const [noteKind, setNoteKind] = useState<EvidenceNoteKind>("documentation");
  const [text, setText] = useState("");
  const [capturedOn, setCapturedOn] = useState(toDateInputValue(new Date()));
  const note = useRecordEvidenceNote();

  return (
    <DecisionDialog
      open
      onClose={onClose}
      title="Write a note"
      consequence={
        noteKind === "settlement_claim" ? (
          <>
            This records that <strong>somebody says</strong> a debt was settled. It is evidence of a
            belief and nothing more: no payment is created, no settlement is recorded, and no
            balance moves. Recording the actual repayment is a separate act against a real movement.
          </>
        ) : (
          <>
            This stores your own account of something as evidence. It creates no payment and no
            obligation.
          </>
        )
      }
      confirmLabel="Store it"
      confirmDisabled={text.trim() === ""}
      reasonLabel="Note for the audit trail"
      pending={note.isPending}
      error={note.error}
      onConfirm={(reason) => {
        note.mutate(
          {
            text: text.trim(),
            noteKind,
            capturedAt: fromDateInputValue(capturedOn),
            ...(reason === undefined ? {} : { reason }),
          },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note-kind">Kind</Label>
          <Select
            id="note-kind"
            value={noteKind}
            onChange={(event) => setNoteKind(event.target.value as EvidenceNoteKind)}
          >
            <option value="documentation">An explanation of something</option>
            <option value="settlement_claim">Somebody says a debt was settled</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note-text">What happened</Label>
          <Textarea
            id="note-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Alex handed me ₹900 in cash for the cab on Saturday."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note-captured">When</Label>
          <Input
            id="note-captured"
            type="date"
            value={capturedOn}
            onChange={(event) => setCapturedOn(event.target.value)}
          />
        </div>
      </div>
    </DecisionDialog>
  );
}

function NotificationDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<NotificationEvidenceType>("upi_notification");
  const [text, setText] = useState("");
  const [capturedOn, setCapturedOn] = useState(toDateInputValue(new Date()));
  const notification = useRecordEvidenceNotification();

  return (
    <DecisionDialog
      open
      onClose={onClose}
      title="Paste a notification"
      consequence={
        <>
          This stores the message exactly as it arrived and records what a deterministic parser
          could read off it — an amount, a direction, a reference. The text is never rewritten by
          that reading, and nothing is linked to a payment: the match is offered later, and accepted
          by you.
        </>
      }
      confirmLabel="Store it"
      confirmDisabled={text.trim() === ""}
      reasonLabel="Note for the audit trail"
      pending={notification.isPending}
      error={notification.error}
      onConfirm={(reason) => {
        notification.mutate(
          {
            type,
            text: text.trim(),
            capturedAt: fromDateInputValue(capturedOn),
            ...(reason === undefined ? {} : { reason }),
          },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notification-type">Where it came from</Label>
          <Select
            id="notification-type"
            value={type}
            onChange={(event) => setType(event.target.value as NotificationEvidenceType)}
          >
            {NOTIFICATION_EVIDENCE_TYPES.map((option) => (
              <option key={option} value={option}>
                {evidenceTypeLabel(option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notification-text">The message, exactly as it arrived</Label>
          <Textarea
            id="notification-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Rs.640.00 debited from A/c XX4821 on 08-Aug-26 to PEPPERMILL CAFE. UPI Ref 884120993741."
          />
          <p className="text-micro text-ink-faint">
            Paste it verbatim. What the parser can read depends on the wording, and an edited
            message is no longer the source.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notification-captured">When it arrived</Label>
          <Input
            id="notification-captured"
            type="date"
            value={capturedOn}
            onChange={(event) => setCapturedOn(event.target.value)}
          />
        </div>
      </div>
    </DecisionDialog>
  );
}
