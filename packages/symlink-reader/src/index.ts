import { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const binaryDirectory = path.join(process.cwd(), 'native');
export const symlinkFile = path.join(binaryDirectory, 'pg-symlinks.json');

// A tuple that contains an entry and its path relative to a base directory
type EntryTuple = { entryPath: string; entry: Dirent };

/**
 * Recursively read all files in a directory, returning not only the names but
 * the Dirents as well.
 */
async function deepRead(directory: string) {
    // Retrieve all files in given directory
    const entries = await fs.readdir(directory, { withFileTypes: true });

    // Loop through all files
    const paths = await Promise.all(entries.map(async (entry): Promise<EntryTuple | EntryTuple[]> => {
        // Combine any received prefixes with the entry name
        const entryPath = path.join(directory, entry.name);

        // GUARD: Check if the file is a directory
        if (entry.isDirectory()) {
            // If so, we recurse based on the entry name, while also passing
            // along the path until now
            return deepRead(path.join(directory, entry.name));
        }

        return { entryPath, entry };
    }));

    // Return the flattened list
    return paths.flat();
}

/**
 * This function will check for any symlinks in the /native folder of the
 * package that is calling it. It will then output a file called
 * `pg-symlinks.json` in said directory that contains all symlinks that were found.
 */
export async function readSymlinks() {
    // First, pull all files out of the folder
    const entries = await deepRead(binaryDirectory);
    
    // Then retrieve all symlinks
    const symlinks = await Promise.all(
        entries.filter((e) => e.entry.isSymbolicLink())
            // ... and map over them
            .map(async (tuple) => {
                // Find the source for the link
                const absoluteSource = await fs.realpath(tuple.entryPath);
                const source = path.relative(process.cwd(), absoluteSource);
                const target = path.relative(process.cwd(), tuple.entryPath);

                // Return a tuple that contains both source and target
                return {
                    source,
                    target,
                };
            })
    );

    // Now, we only need to persist this file to disk!
    await fs.writeFile(symlinkFile, JSON.stringify(symlinks));
}