/**
 * The one principal of the add-on. There are no accounts: every row belongs to
 * this id. Repo functions still take a `userId` and put it in every WHERE
 * clause (the replacement for Postgres RLS), so a row carrying any other id is
 * invisible to them; `assertSingleOwner` in migrate.ts is the startup audit.
 */
export const OWNER_ID = "local-owner";
