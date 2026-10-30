import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const symlinkFile = path.join(packageRoot, 'native', 'pg-symlinks.json');

/**
 * This function will optionally read symlinks from `pg-symlinks.json` and
 * rehydrate them.
 */
export async function hydrateSymlinks() {
    // Retrieve the symlinks
    /** @type {{ source: string, target: string }[]} */
    const symlinks = await fs.readFile(symlinkFile, { encoding: 'utf-8' })
        .then(JSON.parse)
        .catch(() => ([]));

    // Re-hydrate all of them
    for (const { source, target } of symlinks) {
        // Make sure all symlinks are relative to the directory they are in, so
        // that when whole directories are moved, the symlinks don't break as easily.
        const sourcePath = path.resolve(packageRoot, source);
        const targetPath = path.resolve(packageRoot, target);
        const relativeSource = path.relative(path.dirname(targetPath), sourcePath);

        try {
            // We can then create the symlink
            await fs.symlink(relativeSource, targetPath);
        } catch {
            // Swallow any errors, such as files already existing
        }
    }
}

// Only run when this file is executed directly, not when it is imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await hydrateSymlinks();
}
