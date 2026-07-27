/** Bumped when the AppData shape changes. Mirrors the client's SCHEMA_VERSION. */
export const SCHEMA_VERSION = 2;

/** localStorage keys owned by the ledger cache + offline outbox. */
export const STORAGE_KEY  = "apsara_spend_v2";
export const OUTBOX_KEY   = "apsara_outbox_v1";
export const MIGRATED_KEY = "apsara_migrated_to_db_v1";
