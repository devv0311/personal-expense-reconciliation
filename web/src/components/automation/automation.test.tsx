import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobsPanel } from "@/components/automation/jobs-panel";
import { RulesAdmin } from "@/components/automation/rules-admin";
import { OccasionList } from "@/components/expenses/occasions";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { APPLY_RULE, FAILED_JOB, OCCASION, PROPOSE_RULE } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("standing rules", () => {
  function renderRules(): ApiMock {
    const api = mockApi({
      "/api/rules/apply": { outcomes: [], conflicts: [] },
      "/api/rules": { rules: [PROPOSE_RULE, APPLY_RULE], ruleId: "rule-3" },
    });
    renderWithQuery(<RulesAdmin />);
    return api;
  }

  it("marks the rules that write unattended, since those are the consequential ones", async () => {
    renderRules();

    expect(await screen.findByText("Blinkit is a merchant")).toBeInTheDocument();
    expect(screen.getByText("applies unattended")).toBeInTheDocument();
  });

  it("reads each rule's own conditions back as a sentence", async () => {
    renderRules();

    expect(
      await screen.findByText(/narration starts with "NEFT-LANDLORD", money out/),
    ).toBeInTheDocument();
  });

  it("refuses a rule with no condition, because one matching everything is a default", async () => {
    renderRules();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Write a rule" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Everything");

    expect(within(dialog).getByText(/defaults belong in code/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Write it" })).toBeDisabled();
  });

  it("says what an unattended rule will do before it is written", async () => {
    renderRules();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Write a rule" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/every proposal is still yours/)).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("And then"), "apply");
    expect(within(dialog).getByText(/write its fact without asking/)).toBeInTheDocument();
  });

  it("previews a run with dryRun, so nothing is written until a second decision", async () => {
    const api = renderRules();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Preview a run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/This writes/)).toBeInTheDocument();
    expect(within(dialog).getByText("nothing")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Preview it" }));

    await waitFor(() => expect(api.callsTo("/api/rules/apply")).not.toHaveLength(0));
    expect(api.callsTo("/api/rules/apply")[0]!.body).toMatchObject({ dryRun: true });
  });
});

describe("background jobs", () => {
  function renderJobs(): ApiMock {
    const api = mockApi({
      "/api/jobs/job-1/retry": { jobId: "job-1" },
      "/api/jobs": { jobs: [FAILED_JOB], total: 1, limit: 50, offset: 0 },
    });
    renderWithQuery(<JobsPanel />);
    return api;
  }

  it("keeps a failure visible with its error and its attempt count", async () => {
    renderJobs();

    expect(await screen.findAllByText("Classify payments")).not.toHaveLength(0);
    expect(screen.getAllByText("No model provider is configured.")).not.toHaveLength(0);
    expect(screen.getAllByText("2 of 3")).not.toHaveLength(0);
  });

  it("retries only on an explicit act, never on its own", async () => {
    const api = renderJobs();
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Retry" }))[0]!);

    await waitFor(() => expect(api.callsTo("/retry")).not.toHaveLength(0));
  });

  it("says a cancellation is permanent before it happens", async () => {
    renderJobs();
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole("button", { name: "Cancel" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Cancelling is permanent/)).toBeInTheDocument();
  });
});

describe("occasions", () => {
  it("counts the expenses one groups, and never sums their money", async () => {
    mockApi({ "/api/occasions": { occasions: [OCCASION] } });
    renderWithQuery(<OccasionList />);

    expect(await screen.findByText("Anjali's birthday")).toBeInTheDocument();
    expect(screen.getByText("3 expenses")).toBeInTheDocument();
  });

  it("says an occasion carries no money before one is created", async () => {
    mockApi({ "/api/occasions": { occasions: [] } });
    renderWithQuery(<OccasionList />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add an occasion" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/carries no money and creates no obligation/),
    ).toBeInTheDocument();
  });
});
