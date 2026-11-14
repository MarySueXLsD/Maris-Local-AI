// Public keys that sign Maris releases (Ed25519, SPKI DER in base64). While this list is empty, an update is
// checked against the SHA-256 the release publishes. Once it holds a key, the release's checksum list must
// also carry a valid signature by one of these keys, so a release published with stolen GitHub access is
// not installed. Add a key with `node scripts/release-key.mjs` (it says what else to do); keep the old key
// here when adding a new one, so copies of Maris that only know the old one still update.
export const RELEASE_KEYS: readonly string[] = []
