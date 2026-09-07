"use client";

import { useState, type ReactNode } from "react";
import { ErrorBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The one shape every recorded decision in this UI takes: read what you are about to do, say
 * why, then press the button that does it.
 *
 * Three things this enforces for every caller, so no screen can quietly skip one:
 *
 * - **The consequence is spelled out before the button**, in the caller's own words — "this
 *   discards the later payment", "this authorizes no write to Splitwise".
 * - **A required reason is actually required**: the confirm button stays disabled until one is
 *   typed. The services that require a reason would refuse anyway; refusing here means the
 *   person finds out before the request, not after.
 * - **Nothing submits on a keystroke.** Enter inside the reason field types a newline; the
 *   only path to the mutation is the button (ADR-0049).
 */
export function DecisionDialog(props: DecisionDialogProps) {
  // Mounted only while open, so the reason field starts empty every time rather than being
  // cleared by an effect after the fact — a dialog that reopens holding the last reason is a
  // way to submit somebody else's words.
  if (!props.open) return null;
  return <DecisionDialogBody {...props} />;
}

interface DecisionDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What pressing the confirm button will actually do. Never optimistic. */
  consequence: ReactNode;
  confirmLabel: string;
  confirmVariant?: "default" | "outline";
  reasonLabel?: string;
  reasonRequired?: boolean;
  reasonPlaceholder?: string;
  pending: boolean;
  error: unknown;
  children?: ReactNode;
  onConfirm: (reason: string | undefined) => void;
}

function DecisionDialogBody({
  onClose,
  title,
  consequence,
  confirmLabel,
  confirmVariant = "default",
  reasonLabel = "Reason",
  reasonRequired = false,
  reasonPlaceholder,
  pending,
  error,
  children,
  onConfirm,
}: DecisionDialogProps) {
  const [reason, setReason] = useState("");

  const trimmed = reason.trim();
  const blocked = reasonRequired && trimmed.length === 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            disabled={pending || blocked}
            onClick={() => onConfirm(trimmed.length === 0 ? undefined : trimmed)}
          >
            {pending ? "Recording…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="border-l-2 border-accent pl-3 text-body leading-relaxed text-ink">
          {consequence}
        </div>
        {children}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decision-reason">
            {reasonLabel}
            {reasonRequired ? " (required)" : " (optional)"}
          </Label>
          <Textarea
            id="decision-reason"
            disabled={pending}
            value={reason}
            placeholder={reasonPlaceholder}
            onChange={(event) => setReason(event.target.value)}
          />
          {blocked && (
            <p className="text-meta text-attention">
              This decision is recorded with your reason in the audit trail, so it needs one.
            </p>
          )}
        </div>
        {error !== null && error !== undefined && <ErrorBlock error={error} />}
      </div>
    </Dialog>
  );
}
