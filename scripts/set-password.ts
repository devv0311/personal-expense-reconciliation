/**
 * Sets the ledger user's password from the command line.
 *
 * The recovery path `services.setPassword` deliberately has no in-app equivalent of: a local
 * ledger has no second channel to send a reset link down, so the answer to a forgotten
 * password is physical access to the machine the database is on — which is the same access
 * that would let someone read the database directly anyway.
 *
 * ```
 * npx tsx scripts/set-password.ts you@example.test
 * ```
 *
 * The password is read from stdin rather than argv, so it does not land in the shell history
 * or in the process list.
 */

import { createInterface } from 'node:readline/promises';

import { createPgliteDatabase, createPostgresDatabase, getUserByEmail } from '../src/db/index.js';
import type { DatabaseHandle } from '../src/db/index.js';
import { setPassword } from '../src/services/index.js';

async function openDatabase(): Promise<DatabaseHandle> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString !== undefined && connectionString !== '') {
    return createPostgresDatabase(connectionString);
  }
  return createPgliteDatabase(process.env.PGLITE_DATA_DIR ?? './local-data/pglite-dev');
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (email === undefined) {
    console.error('Usage: npx tsx scripts/set-password.ts <email>');
    process.exitCode = 1;
    return;
  }

  const handle = await openDatabase();
  try {
    await handle.migrate();
    const user = await getUserByEmail(handle.db, email.trim().toLowerCase());
    if (user === null) {
      console.error(`No account with email ${email}.`);
      process.exitCode = 1;
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const password = await rl.question('New password (at least 12 characters): ');
    const again = await rl.question('Again: ');
    rl.close();

    if (password !== again) {
      console.error('Those did not match. Nothing was changed.');
      process.exitCode = 1;
      return;
    }

    await setPassword(handle.db, {
      userId: user.id,
      password,
      audit: { actor: 'user', source: 'scripts/set-password.ts' },
    });
    console.log(`Password set for ${user.email}. Existing sessions are unaffected; sign out`);
    console.log('from the app if you want to end them.');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to set the password:', error);
  process.exitCode = 1;
});
