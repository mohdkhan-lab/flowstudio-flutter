const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { LOCK_FILE_NAMES } = require('./processHelper');

/**
 * FlowStudio Lite — profile working copies (v1.3).
 *
 * Read-only checks (credit Sync, login verification) must keep working
 * even when the account's real profile is genuinely held by an
 * interactive Chrome the user has open. For those checks the app copies
 * the profile to a per-account temp working dir, launches the check
 * against the COPY, and deletes the copy afterwards. The session data
 * that matters (Cookies, Preferences, Local State for cookie
 * decryption) comes along; locks and pure-cache bulk do not.
 *
 * WHY GENERATION NEVER USES A WORKING COPY: a live Flow session rotates
 * its session cookies (e.g. __Secure-1PSIDTS) as it works. If generation
 * ran on a throwaway copy, the rotated tokens would be written to the
 * copy and discarded, leaving the REAL profile holding stale — possibly
 * invalidated — session state, and the next run would face a forced
 * re-login. Generation therefore keeps the strict behavior: orphan
 * cleanup, then skip a genuinely busy account with a clear reason.
 * Credit READS are safe on a copy: they observe the session, they don't
 * depend on persisting its rotation back.
 */

// Files/dirs that must never be copied: singleton locks (copying them
// would recreate the very "busy" state we are avoiding) and heavy cache
// trees (irrelevant to a session check, slow to copy, often locked).
const COPY_EXCLUDE_NAMES = new Set([
  ...LOCK_FILE_NAMES,
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Service Worker',
  'blob_storage',
  'Crashpad'
]);

async function copyDirInto(srcDir, destDir, warnings) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_EXCLUDE_NAMES.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true });
      await copyDirInto(src, dest, warnings);
    } else if (entry.isFile()) {
      try {
        await fsp.copyFile(src, dest);
      } catch (err) {
        // The Cookies database is the one file the copy cannot do
        // without — if Windows has it locked even for reading, the
        // whole copy is useless and the caller must say so honestly.
        if (entry.name === 'Cookies') throw err;
        warnings.push(`${entry.name}: ${err.message}`);
      }
    }
    // Symlinks and other exotic entries are skipped: a check copy only
    // needs regular files.
  }
}

/**
 * Copy profilePath into destDir (created fresh; any previous copy at
 * destDir is removed first). Resolves destDir on success; rejects when
 * the source is missing or an essential file (Cookies) cannot be read.
 */
async function buildProfileWorkingCopy(profilePath, destDir) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    throw new Error(`Profile not found at: ${profilePath}`);
  }
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const warnings = [];
  await copyDirInto(profilePath, destDir, warnings);
  return destDir;
}

/** Best-effort removal of a working copy; never throws. */
async function removeProfileWorkingCopy(destDir) {
  if (!destDir) return;
  try {
    await fsp.rm(destDir, { recursive: true, force: true });
  } catch (e) {}
}

module.exports = {
  buildProfileWorkingCopy,
  removeProfileWorkingCopy,
  COPY_EXCLUDE_NAMES
};
