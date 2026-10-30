import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Verify that all symlinks listed in `pg-symlinks.json` are present. Throws on
 * the first missing symlink.
 */
export async function verifySymlinks(symlinkFile: string): Promise<void> {
    const symlinks = JSON.parse(
        await fs.readFile(symlinkFile, 'utf-8')
    ) as { target: string }[];
    const packageRoot = path.resolve(path.dirname(symlinkFile), '..');

    await Promise.all(symlinks.map(async ({ target }) => {
        const targetPath = path.resolve(packageRoot, target);

        try {
            await fs.access(targetPath);
        } catch {
            const packageName = await getPackageName(packageRoot);
            throw new Error(formatMissingSymlinkError(target, packageName));
        }
    }));
}

/**
 * Ensure that the symlinks required by the Postgres binaries are present.
 * When `autoRehydrateSymlinks` is enabled, attempt to recreate missing
 * symlinks before giving up.
 */
export async function ensureSymlinks(
    postgresPath: string,
    autoRehydrateSymlinks: boolean
): Promise<void> {
    const packageRoot = path.resolve(path.dirname(postgresPath), '..', '..');
    const hydrateScript = path.join(packageRoot, 'scripts', 'hydrate-symlinks.js');
    const { hydrateSymlinks, symlinkFile } = await import(pathToFileURL(hydrateScript).href);

    try {
        await verifySymlinks(symlinkFile);
    } catch (error) {
        if (!autoRehydrateSymlinks) {
            throw error;
        }

        await hydrateSymlinks();
        await verifySymlinks(symlinkFile);
    }
}

/**
 * Retrieve the name of the package that owns the symlink manifest.
 */
async function getPackageName(packageRoot: string) {
    try {
        const packageJson = JSON.parse(
            await fs.readFile(path.join(packageRoot, 'package.json'), 'utf-8')
        ) as { name?: string };

        return packageJson.name;
    } catch {
        return undefined;
    }
}

/**
 * Build an actionable error message for a missing symlink.
 */
function formatMissingSymlinkError(target: string, packageName?: string) {
    const name = packageName ?? 'this package';
    const commandTarget = packageName ?? '<package>';

    return [
        `Missing symlink "${target}". The install script for ${name} may not have run.`,
        '',
        'Run the install script:',
        `  npm:  npm rebuild ${commandTarget}`,
        `        (if you use --strict-allow-scripts, first run: npm approve-scripts ${commandTarget})`,
        `  pnpm: pnpm approve-builds ${commandTarget}`,
        '        (or run pnpm approve-builds and select the package)',
        `  bun:  bun pm trust ${commandTarget}`,
        '        (or add it to "trustedDependencies" in package.json, then run bun install)',
        '',
        'Or set `autoRehydrateSymlinks: true` to recreate symlinks at runtime.',
    ].join('\n');
}
