import os from 'os';
import fs from 'fs/promises';
import path from 'path';

export type PostgresBinaries = {
    postgres: string;
    pg_ctl: string;
    initdb: string;
}

/**
 * npm does not preserve symlinks when publishing packages. The platform
 * packages include a `pg-symlinks.json` file that records the original
 * symlinks, and a `postinstall` script (`hydrate-symlinks.js`) to restore
 * them. However, some package managers and tools (e.g. bunx, pnpm with
 * --ignore-scripts, yarn PnP) skip lifecycle scripts, so the symlinks may
 * never be restored.
 *
 * This function ensures symlinks are hydrated at runtime if they are missing,
 * so the postgres binaries work regardless of how the package was installed.
 */
async function hydrateSymlinksIfNeeded(binPath: string): Promise<void> {
    // Resolve the native directory from the binary path (bin -> native -> pg-symlinks.json)
    const nativeDir = path.dirname(path.dirname(binPath));
    const symlinkFile = path.join(nativeDir, 'pg-symlinks.json');

    // Read the symlinks manifest
    let symlinks: { source: string; target: string }[];
    try {
        const content = await fs.readFile(symlinkFile, { encoding: 'utf-8' });
        symlinks = JSON.parse(content);
    } catch {
        // No symlinks file found — nothing to do
        return;
    }

    // The paths in pg-symlinks.json are relative to the package root (parent of native/)
    const packageRoot = path.dirname(nativeDir);

    for (const { source, target } of symlinks) {
        const absoluteTarget = path.resolve(packageRoot, target);

        // Only create symlinks that don't already exist
        try {
            await fs.lstat(absoluteTarget);
        } catch {
            // Target doesn't exist — create the symlink
            const absoluteSource = path.resolve(packageRoot, source);
            const dirname = path.dirname(absoluteTarget);
            const relSource = path.relative(dirname, absoluteSource);

            try {
                await fs.symlink(relSource, absoluteTarget);
            } catch {
                // Swallow errors (e.g. read-only filesystem, race conditions)
            }
        }
    }
}

async function getBinaries(): Promise<PostgresBinaries> {
    const arch = os.arch();
    const platform = os.platform();

    let binaries: PostgresBinaries;

    switch (platform) {
        case 'darwin':
            switch(arch) {
                case 'arm64':
                    binaries = await import('@embedded-postgres/darwin-arm64');
                    break;
                case 'x64':
                    binaries = await import('@embedded-postgres/darwin-x64');
                    break;
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);
            }
            break;
        case 'linux':
            switch(arch) {
                case 'arm64':
                    binaries = await import('@embedded-postgres/linux-arm64');
                    break;
                case 'arm':
                    binaries = await import('@embedded-postgres/linux-arm');
                    break;
                case 'ia32':
                    binaries = await import('@embedded-postgres/linux-ia32');
                    break;
                case 'ppc64':
                    binaries = await import('@embedded-postgres/linux-ppc64');
                    break;
                case 'x64':
                    binaries = await import('@embedded-postgres/linux-x64');
                    break;
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);
            }
            break;
        case 'win32':
            switch(arch) {
                case 'x64':
                    binaries = await import('@embedded-postgres/windows-x64');
                    break;
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);
            }
            break;
        default:
            throw new Error(`Unsupported platform "${platform}"`);
    }

    // Ensure symlinks are hydrated before returning binary paths
    await hydrateSymlinksIfNeeded(binaries.postgres);

    return binaries;
}

export default getBinaries;