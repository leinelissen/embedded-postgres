import fs from 'fs/promises';
import path from 'path';

const symlinkFile = path.join(process.cwd(), 'native', 'pg-symlinks.json');
const originalWorkingDirectory = process.cwd();

/**
 * This function will optionally read symlinks from `pg-symlinks.json` and
 * rehydrate them.
 */
async function hydrateSymlinks() {
    // Retrieve the symlinks
    /** @type {{ source: string, target: string }[]} */
    const symlinks = await fs.readFile(symlinkFile, { encoding: 'utf-8' })
        .then(JSON.parse)
        .catch(() => ([]));

    // Re-hydrate all of them
    for (let { source, target } of symlinks) {
        // Make sure all symlinks are relative to the directory they are in, so
        // that when whole directories are moved, the symlinks don't break as easily.
        const dirname = path.dirname(source);
        const relSource = path.relative(dirname, source);
        const relTarget = path.relative(dirname, target);

        // To make this work, we need to change the working directory for NodeJS
        process.chdir(dirname);

        try {
            // We can then create the symlink
            await fs.symlink(relSource, relTarget);
        } catch {
            // Swallow any errors, such as files already existing
        }

        // And switch back to the original working directory
        process.chdir(originalWorkingDirectory);
    }
}

hydrateSymlinks();