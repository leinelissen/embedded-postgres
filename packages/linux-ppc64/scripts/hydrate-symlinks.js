const fs = require('fs/promises');
const path = require('path');

const symlinkFile = path.join(process.cwd(), 'native', 'pg-symlinks.json');

/**
 * This function will optionally read symlinks from `pg-symlinks.json` and
 * rehydrate them.
 */
async function hydrateSymlinks() {
    // Retrieve the symlinks
    /** @type {{ source: string, target: string }[]} */
    const symlinks = await fs.readFile(symlinkFile, { encoding: 'utf-8' })
        .then(JSON.parse);

    // Re-hydrate all of them
    await Promise.all(
        symlinks.map(({ source, target }) => {
            return fs.link(source, target);
        })
    // Swallow any errors, since the symlinks may already exist
    ).catch(() => {});
}

hydrateSymlinks();