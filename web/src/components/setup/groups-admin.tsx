"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDate, fromDateInputValue, toDateInputValue } from "@/lib/dates";
import {
  useAddGroupMember,
  useCreateGroup,
  useEndGroupMembership,
  useGroups,
  usePeople,
} from "@/lib/queries";
import type { GroupDetail } from "@/lib/types";

/**
 * Groups, and the dated membership stints that make a group allocation resolvable.
 *
 * The dates are the whole reason this screen is not just a list of names. A `group`-typed
 * allocation line is expanded into individual people **as of the expense's date** (ADR-0009),
 * and the expansion is snapshotted — so someone joining the flat today does not retroactively
 * acquire a share of last month's dinner, and someone leaving does not lose the share they
 * already owe. A group is never itself a debtor.
 */
export function GroupsAdmin() {
  const [adding, setAdding] = useState(false);
  const [memberFor, setMemberFor] = useState<GroupDetail | null>(null);
  const [ending, setEnding] = useState<{ membershipId: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [personId, setPersonId] = useState("");
  const [joinedOn, setJoinedOn] = useState(toDateInputValue(new Date()));
  const [leftOn, setLeftOn] = useState(toDateInputValue(new Date()));

  const groups = useGroups();
  const people = usePeople();
  const create = useCreateGroup();
  const addMember = useAddGroupMember();
  const endMembership = useEndGroupMembership();

  return (
    <Section
      title="Groups"
      headingId="groups"
      description="A flat, a trip, a recurring set of people. Allocating to a group expands into its members as of the expense date — the group itself never owes anything."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setName("");
            setType("");
            create.reset();
            setAdding(true);
          }}
        >
          Add a group
        </Button>
      }
    >
      {groups.isPending && (
        <LoadingStatus label="Loading groups…">
          <TableSkeleton columns={2} />
        </LoadingStatus>
      )}
      {groups.isError && <ErrorBlock error={groups.error} onRetry={() => void groups.refetch()} />}
      {groups.isSuccess && groups.data.length === 0 && (
        <EmptyBlock>No groups yet. Expenses can still be split between named people.</EmptyBlock>
      )}
      {groups.isSuccess && groups.data.length > 0 && (
        <ul className="flex flex-col gap-6">
          {groups.data.map((group) => (
            <li key={group.id} className="border-b border-rule pb-4 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <span className="text-body text-ink">{group.name}</span>
                  <span className="ml-2 text-micro text-ink-faint">
                    {group.type ?? "No type"}
                    {group.archivedAt === null ? "" : " · archived"}
                  </span>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setPersonId("");
                    setJoinedOn(toDateInputValue(new Date()));
                    addMember.reset();
                    setMemberFor(group);
                  }}
                >
                  Add a member
                </Button>
              </div>
              {group.memberships.length === 0 ? (
                <p className="mt-2 text-meta text-attention">
                  Nobody is in it, so an allocation to this group cannot be expanded into shares.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {group.memberships.map((membership) => (
                    <li
                      key={membership.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 text-meta"
                    >
                      <span className="text-ink">{membership.displayName}</span>
                      <span className="text-ink-muted">
                        {formatDate(membership.joinedAt)} –{" "}
                        {membership.leftAt === null ? "present" : formatDate(membership.leftAt)}
                        <Button
                          variant="link"
                          size="sm"
                          className="ml-3"
                          onClick={() => {
                            setLeftOn(toDateInputValue(new Date()));
                            endMembership.reset();
                            setEnding({
                              membershipId: membership.id,
                              name: membership.displayName,
                            });
                          }}
                        >
                          {membership.leftAt === null ? "End stint" : "Reopen"}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <DecisionDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a group"
        consequence="This creates a group that expenses can be allocated to. It creates no obligation: a group is expanded into people before anything can be owed."
        confirmLabel="Add it"
        confirmDisabled={name.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={() => {
          create.mutate(
            { name: name.trim(), ...(type.trim() === "" ? {} : { type: type.trim() }) },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              placeholder="Flat 402"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-type">Type</Label>
            <Input
              id="group-type"
              value={type}
              placeholder="flatmates"
              onChange={(event) => setType(event.target.value)}
            />
          </div>
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={memberFor !== null}
        onClose={() => setMemberFor(null)}
        title={memberFor === null ? "Add a member" : `Add someone to ${memberFor.name}`}
        consequence={
          <>
            This starts a dated membership stint. Only expenses on or after that date expand to
            include them — joining a group never gives someone a share of a past expense, and an
            allocation already saved keeps the expansion it was computed with.
          </>
        }
        confirmLabel="Add them"
        confirmDisabled={personId === ""}
        reasonLabel="Note for the audit trail"
        pending={addMember.isPending}
        error={addMember.error}
        onConfirm={() => {
          if (memberFor === null) return;
          addMember.mutate(
            { groupId: memberFor.id, personId, joinedAt: fromDateInputValue(joinedOn) },
            { onSuccess: () => setMemberFor(null) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-person">Person</Label>
            <Select
              id="member-person"
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
            >
              <option value="">Choose someone…</option>
              {(people.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                  {person.isUser ? " (you)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-joined">Joined on</Label>
            <Input
              id="member-joined"
              type="date"
              value={joinedOn}
              onChange={(event) => setJoinedOn(event.target.value)}
            />
          </div>
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={ending === null ? "End a stint" : `End ${ending.name}'s stint`}
        consequence={
          <>
            This ends the membership from the date you choose. Expenses before it still expand to
            include them, and every share they already owe stands — leaving a flat does not
            discharge a debt.
          </>
        }
        confirmLabel="End it"
        reasonLabel="Note for the audit trail"
        pending={endMembership.isPending}
        error={endMembership.error}
        onConfirm={() => {
          if (ending === null) return;
          endMembership.mutate(
            { membershipId: ending.membershipId, leftAt: fromDateInputValue(leftOn) },
            { onSuccess: () => setEnding(null) },
          );
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="member-left">Left on</Label>
          <Input
            id="member-left"
            type="date"
            value={leftOn}
            onChange={(event) => setLeftOn(event.target.value)}
          />
        </div>
      </DecisionDialog>
    </Section>
  );
}
