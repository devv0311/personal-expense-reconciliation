import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsAdmin } from "@/components/setup/accounts-admin";
import { GroupsAdmin } from "@/components/setup/groups-admin";
import { MerchantsAdmin } from "@/components/setup/merchants-admin";
import { PeopleAdmin } from "@/components/setup/people-admin";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import {
  ACCOUNT,
  GROUP,
  MERCHANT,
  MERCHANT_WITHOUT_ALIAS,
  PEOPLE,
  PERSON_DETAILS,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("people", () => {
  function renderPeople(): ApiMock {
    const api = mockApi({
      "/api/people/manage": { people: PERSON_DETAILS },
      "/api/people": { person: PERSON_DETAILS[1] },
    });
    renderWithQuery(<PeopleAdmin />);
    return api;
  }

  it("marks the ledger's own user, and says who is not mapped to Splitwise", async () => {
    renderPeople();

    expect(await screen.findByText("you")).toBeInTheDocument();
    expect(screen.getByText("Not mapped")).toBeInTheDocument();
  });

  it("adds a person without creating any obligation", async () => {
    const api = renderPeople();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add a person" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/creates no expense, no obligation and no payment/),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "Priya");
    await user.click(within(dialog).getByRole("button", { name: "Add them" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).not.toHaveLength(0),
    );
    expect(api.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      displayName: "Priya",
      actor: "user",
    });
  });
});

describe("accounts", () => {
  it("refuses more than four digits of an account number", async () => {
    mockApi({ "/api/accounts": { accounts: [ACCOUNT] } });
    renderWithQuery(<AccountsAdmin />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add an account" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "ICICI current");
    await user.type(within(dialog).getByLabelText("Last four digits"), "12345");

    expect(within(dialog).getByText(/at most four/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add it" })).toBeDisabled();
  });

  it("says closing an account leaves its recorded movements alone", async () => {
    mockApi({ "/api/accounts": { accounts: [ACCOUNT] } });
    renderWithQuery(<AccountsAdmin />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /every movement already recorded against it stays exactly as it is/i,
      ),
    ).toBeInTheDocument();
  });
});

describe("merchants", () => {
  it("flags a merchant with no alias, because nothing will ever resolve to it", async () => {
    mockApi({ "/api/merchants": { merchants: [MERCHANT, MERCHANT_WITHOUT_ALIAS] } });
    renderWithQuery(<MerchantsAdmin />);

    expect(await screen.findByText(/None — nothing will ever resolve to it/)).toBeInTheDocument();
    expect(screen.getByText("UPI-BLINKIT-PAYU@AXIS")).toBeInTheDocument();
  });

  it("teaches a narration exactly as typed, and says normalization is what applies it", async () => {
    const api = mockApi({
      "/api/merchants/m-blinkit/aliases": { aliasId: "al-2" },
      "/api/merchants": { merchants: [MERCHANT] },
    });
    renderWithQuery(<MerchantsAdmin />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add alias" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Payments already normalized keep the counterparty/),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Narration"), "UPI-BLINKIT-NEW@ICICI");
    await user.click(within(dialog).getByRole("button", { name: "Add it" }));

    await waitFor(() => expect(api.callsTo("/aliases")).not.toHaveLength(0));
    expect(api.callsTo("/aliases")[0]!.body).toMatchObject({
      rawPattern: "UPI-BLINKIT-NEW@ICICI",
    });
  });
});

describe("groups", () => {
  function renderGroups(): ApiMock {
    const api = mockApi({
      "/api/groups/g-flat/members": { membershipId: "gm-3" },
      "/api/groups": { groups: [GROUP] },
      "/api/people": { people: PEOPLE },
    });
    renderWithQuery(<GroupsAdmin />);
    return api;
  }

  it("shows each membership as a dated stint, not a flat list of names", async () => {
    renderGroups();

    expect(await screen.findByText("Flat 402")).toBeInTheDocument();
    expect(screen.getByText(/1 Jan 2026 – present/)).toBeInTheDocument();
    expect(screen.getByText(/1 Mar 2026 – 1 Aug 2026/)).toBeInTheDocument();
  });

  it("sends the join date, because membership is resolved as of the expense date", async () => {
    const api = renderGroups();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add a member" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/joining a group never gives someone a share of a past expense/),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Person"), "p-alex");
    await user.click(within(dialog).getByRole("button", { name: "Add them" }));

    await waitFor(() => expect(api.callsTo("/members")).not.toHaveLength(0));
    const body = api.callsTo("/members")[0]!.body as Record<string, unknown>;
    expect(body["personId"]).toBe("p-alex");
    expect(String(body["joinedAt"])).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });
});
