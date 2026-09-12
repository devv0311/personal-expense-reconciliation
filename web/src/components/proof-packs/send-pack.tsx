"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { ErrorBlock, FieldSkeleton, LoadingStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/dates";
import { evidenceTypeLabel } from "@/lib/labels";
import {
  useMessagingStatus,
  useProofPackDeliveries,
  useRetryProofPackDelivery,
  useSendProofPack,
} from "@/lib/queries";
import type { ProofPackDelivery, ProofPackPreview } from "@/lib/types";

/**
 * The send step: a separate, explicit act *after* the recipient/content/evidence review
 * (audit row 42, ADR-0053).
 *
 * Three things this screen refuses to blur, because each is a way somebody gets hurt:
 *
 * - **Copying and sending are different acts.** Copying puts text on a clipboard; sending puts
 *   it in front of another person. The copy button above is unchanged and still sends nothing;
 *   this section is the other one, and it says so.
 * - **An unconfigured installation says so up front.** No transport means the send form is
 *   replaced by the reason it is unavailable, naming the variables — rather than a button that
 *   fails after somebody has typed a phone number.
 * - **Nothing here computes a figure.** The message is derived by the API at the moment of
 *   sending; this component posts a recipient, an address and three confirmations. The digest
 *   it echoes back is the server's own, so a pack that moved since it was read is refused
 *   rather than sent.
 */
export function SendPack({
  preview,
  reviewed,
}: {
  preview: ProofPackPreview;
  /** Whether all three review checkboxes above have been ticked. */
  reviewed: boolean;
}) {
  const status = useMessagingStatus();
  const deliveries = useProofPackDeliveries(preview.intendedRecipient.id);

  return (
    <Section
      title="Send it"
      headingId="pack-send"
      description="A separate act from copying. Copying puts the text on your clipboard; sending puts it in front of this person. Neither records a settlement — if they pay you, that is a payment with its own evidence."
    >
      {status.isPending && (
        <LoadingStatus label="Checking what this installation can send…">
          <FieldSkeleton />
        </LoadingStatus>
      )}
      {status.isError && <ErrorBlock error={status.error} onRetry={() => void status.refetch()} />}

      {status.isSuccess && !status.data.configured && (
        <div className="rounded-sm border border-rule bg-panel p-4">
          <p className="text-body text-ink">Sending is not configured on this installation.</p>
          <p className="mt-2 text-meta text-ink-muted">{status.data.unavailableReason}</p>
        </div>
      )}

      {status.isSuccess && status.data.configured && (
        <SendForm
          preview={preview}
          reviewed={reviewed}
          transportLabel={status.data.label}
          endpointHost={status.data.endpointHost ?? null}
          supportsAttachments={status.data.supportsAttachments}
          attachableTypes={status.data.attachableEvidenceTypes}
        />
      )}

      <div className="mt-8">
        <h3 className="text-meta text-ink-muted">What has been sent to this person</h3>
        {deliveries.isPending && (
          <LoadingStatus label="Loading the sharing record…">
            <FieldSkeleton />
          </LoadingStatus>
        )}
        {deliveries.isError && (
          <ErrorBlock error={deliveries.error} onRetry={() => void deliveries.refetch()} />
        )}
        {deliveries.isSuccess && <DeliveryHistory deliveries={deliveries.data} />}
      </div>
    </Section>
  );
}

function SendForm({
  preview,
  reviewed,
  transportLabel,
  endpointHost,
  supportsAttachments,
  attachableTypes,
}: {
  preview: ProofPackPreview;
  reviewed: boolean;
  transportLabel: string;
  endpointHost: string | null;
  supportsAttachments: boolean;
  attachableTypes: readonly string[];
}) {
  const [address, setAddress] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);
  const send = useSendProofPack();

  // Only what the pack actually cites, and only the types that may ever leave this machine.
  // The list the API returns is the authority; this filters by it rather than restating it.
  const attachable = preview.evidenceReferences.filter((reference) =>
    attachableTypes.includes(reference.type),
  );
  const blocked = preview.evidenceReferences.length - attachable.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-sm">
        <Label htmlFor="send-address">Their WhatsApp number</Label>
        <Input
          id="send-address"
          value={address}
          inputMode="tel"
          placeholder="+919876543210"
          onChange={(event) => setAddress(event.target.value)}
        />
        <p className="mt-1 text-micro text-ink-faint">
          International form, with the country code. Nothing is guessed — a number without one is
          refused rather than assumed to be Indian.
        </p>
      </div>

      {supportsAttachments && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-meta text-ink-muted">
            Attach supporting receipts (optional)
          </legend>
          {attachable.length === 0 ? (
            <p className="text-meta text-ink-muted">
              This pack cites no receipt that may be attached.
            </p>
          ) : (
            attachable.map((reference) => (
              <div key={reference.evidenceId} className="flex items-start gap-2">
                <input
                  id={`attach-${reference.evidenceId}`}
                  type="checkbox"
                  className="mt-1 size-4 accent-accent"
                  checked={selected.includes(reference.evidenceId)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, reference.evidenceId]
                        : current.filter((id) => id !== reference.evidenceId),
                    )
                  }
                />
                <label htmlFor={`attach-${reference.evidenceId}`} className="text-body text-ink">
                  {reference.label ?? evidenceTypeLabel(reference.type)}
                </label>
              </div>
            ))
          )}
          {blocked > 0 && (
            <p className="text-micro text-ink-faint">
              {blocked} other cited {blocked === 1 ? "record is" : "records are"} never attachable —
              a statement line, a notification or a private note carries facts about your own
              accounts rather than about the shared purchase.
            </p>
          )}
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!reviewed || address.trim().length === 0} onClick={() => setOpen(true)}>
          Send through {transportLabel}
        </Button>
        {!reviewed && (
          <span className="text-meta text-ink-muted">
            Confirm all three review checks above first.
          </span>
        )}
        {send.isSuccess && (
          <span role="status" className="text-meta text-credit">
            {send.data.sentNow
              ? `Sent. Recorded as ${send.data.delivery.status}. No settlement was recorded.`
              : "An identical pack had already gone to that number, so nothing was sent again."}
          </span>
        )}
      </div>

      {send.isError && <ErrorBlock error={send.error} />}

      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Send this proof pack"
        confirmLabel="Send it"
        pending={send.isPending}
        error={null}
        consequence={
          <>
            This puts the message above in front of {preview.intendedRecipient.displayName} at{" "}
            <span className="font-mono">{address.trim()}</span>
            {endpointHost === null ? "" : `, through ${endpointHost}`}
            {selected.length > 0
              ? `, with ${selected.length} receipt${selected.length === 1 ? "" : "s"} attached`
              : ""}
            . It leaves this machine and cannot be recalled. It records that you sent it — and it
            records no settlement: if they pay you, that is a separate payment with its own
            evidence.
          </>
        }
        onConfirm={(reason) => {
          send.mutate(
            {
              recipientPersonId: preview.intendedRecipient.id,
              channel: "whatsapp",
              address: address.trim(),
              asOf: preview.asOf,
              review: {
                recipientConfirmed: true,
                contentConfirmed: true,
                evidenceConfirmed: true,
              },
              contentDigestSeen: preview.contentDigest,
              ...(selected.length === 0 ? {} : { attachEvidenceIds: selected }),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setOpen(false) },
          );
        }}
      />
    </div>
  );
}

function DeliveryHistory({ deliveries }: { deliveries: readonly ProofPackDelivery[] }) {
  const retry = useRetryProofPackDelivery();
  const [retrying, setRetrying] = useState<string | null>(null);

  if (deliveries.length === 0) {
    return (
      <p className="mt-2 text-body text-ink-muted">
        Nothing has been sent to this person from here. That is a statement about this ledger&apos;s
        own record, not about what you may have sent by other means.
      </p>
    );
  }

  return (
    <>
      <ResponsiveTable
        caption="Proof packs sent to this person"
        minWidth="560px"
        rows={deliveries}
        rowKey={(delivery) => delivery.id}
        rowNote={(delivery) =>
          delivery.lastError === null ? null : (
            <span className="mt-0.5 block text-micro text-attention">{delivery.lastError}</span>
          )
        }
        columns={[
          {
            key: "when",
            header: "When",
            render: (delivery) => formatDateTime(delivery.createdAt),
          },
          {
            key: "to",
            header: "To",
            render: (delivery) => <span className="font-mono">{delivery.address}</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (delivery) => (
              <span
                className={
                  delivery.status === "failed"
                    ? "text-debit"
                    : delivery.status === "delivered"
                      ? "text-credit"
                      : "text-ink"
                }
              >
                {deliveryStatusLabel(delivery.status)}
                {delivery.attemptCount > 1 ? ` · ${delivery.attemptCount} attempts` : ""}
              </span>
            ),
          },
          {
            key: "attachments",
            header: "Attached",
            align: "right",
            render: (delivery) => String(delivery.attachments.length),
          },
          {
            key: "action",
            header: "",
            render: (delivery) =>
              delivery.retryable ? (
                <Button variant="outline" onClick={() => setRetrying(delivery.id)}>
                  Try again
                </Button>
              ) : null,
          },
        ]}
      />

      <DecisionDialog
        open={retrying !== null}
        onClose={() => setRetrying(null)}
        title="Try this delivery again"
        confirmLabel="Try again"
        pending={retry.isPending}
        error={retry.error}
        consequence={
          <>
            This sends the message exactly as it was recorded — not a freshly derived one, which
            could say something different under a record that says otherwise. It reaches the same
            number.
          </>
        }
        onConfirm={(reason) => {
          if (retrying === null) return;
          retry.mutate(
            { deliveryId: retrying, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setRetrying(null) },
          );
        }}
      />
    </>
  );
}

function deliveryStatusLabel(status: ProofPackDelivery["status"]): string {
  switch (status) {
    case "pending":
      return "Not sent yet";
    case "sent":
      return "Handed to the provider";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Failed";
  }
}
