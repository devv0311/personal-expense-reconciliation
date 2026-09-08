"use client";

import { useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { useSession, useSetPassword, useSignIn } from "@/lib/queries";

/**
 * What stands between a browser and the ledger when the API is enforcing authentication.
 *
 * Three states, and the distinction between the first two is the point (audit row 50):
 *
 * - **No password exists yet.** A fresh installation. Offering a sign-in form nobody can
 *   satisfy would be a dead end, so this offers to set one instead.
 * - **A password exists and nobody is signed in.** Sign in.
 * - **The API is not enforcing it at all** (`AUTH_REQUIRED=false`, the ordinary local run).
 *   The app renders, and the nav says plainly that nothing is locked — implying a lock that is
 *   not there would be worse than having none.
 *
 * The gate is deliberately client-side and deliberately not the security boundary: the API
 * refuses an unauthenticated request on its own (`router.ts`), whatever this renders.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();

  if (session.isPending) {
    return (
      <LoadingStatus label="Checking who you are signed in as…">
        <TableSkeleton columns={2} rows={2} />
      </LoadingStatus>
    );
  }
  // An unreachable API is not "signed out". Saying so, and rendering the app, keeps the error
  // where it belongs — on the screen that failed to load — rather than behind a login wall.
  if (session.isError) {
    return (
      <div className="flex flex-col gap-6">
        <ErrorBlock error={session.error} onRetry={() => void session.refetch()} />
        {children}
      </div>
    );
  }

  const state = session.data;
  if (!state.authenticationRequired || state.session !== null) return <>{children}</>;

  return state.authenticationConfigured ? <SignInForm /> : <FirstRunForm />;
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useSignIn();

  return (
    <form
      className="mx-auto flex max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        signIn.mutate({ email, password });
      }}
    >
      <h1 className="text-h1 font-medium text-ink">Sign in</h1>
      <p className="text-body text-ink-muted">
        This ledger holds statements, receipts and balances. It is served with authentication on, so
        nothing below is readable until you sign in.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sign-in-email">Email</Label>
        <Input
          id="sign-in-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sign-in-password">Password</Label>
        <Input
          id="sign-in-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {signIn.isError && <ErrorBlock error={signIn.error} />}
      <div>
        <Button type="submit" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}

function FirstRunForm() {
  const [password, setPasswordValue] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const setPassword = useSetPassword();

  const mismatch = confirmation.length > 0 && confirmation !== password;

  return (
    <form
      className="mx-auto flex max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (mismatch) return;
        setPassword.mutate({ password });
      }}
    >
      <h1 className="text-h1 font-medium text-ink">Set a password</h1>
      <Alert variant="attention">
        <AlertTitle>No password has been set yet</AlertTitle>
        <AlertDescription>
          <p>
            This is a first run. Nobody can sign in until a password exists, and this API is
            enforcing authentication — so this is the only way in.
          </p>
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="first-run-password">Password</Label>
        <Input
          id="first-run-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="first-run-confirm">Again</Label>
        <Input
          id="first-run-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
        {mismatch && <p className="text-meta text-attention">These do not match.</p>}
      </div>
      {setPassword.isError && <ErrorBlock error={setPassword.error} />}
      <div>
        <Button type="submit" disabled={setPassword.isPending || mismatch}>
          {setPassword.isPending ? "Setting it…" : "Set it"}
        </Button>
      </div>
    </form>
  );
}
