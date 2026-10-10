// Platform facts the tests rely on (P08-G7, #192), each recorded as a deviation in
// docs/evidence/P08_G7_CROSS_PLATFORM_2026-10-10.md.

/**
 * POSIX permission bits. Windows keeps only a read-only flag, so every writable file there
 * reads as 0o666; owner-only access comes from the folder's access control lists instead.
 */
export const POSIX_MODES = process.platform !== "win32";

/** The permission bits a writable file shows: `posix` where they exist, 0o666 on Windows. */
export const writableMode = (posix) => (POSIX_MODES ? posix : 0o666);

/** FIFOs (named pipes in the file system). Windows has none; its named pipes live elsewhere. */
export const HAS_FIFOS = process.platform !== "win32";
export const NO_FIFOS = "Windows has no FIFOs";
