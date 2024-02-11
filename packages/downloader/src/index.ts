import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import { coerce } from 'semver';
import os from 'os';

type AcceptedArchs = 'amd64' | 'arm64v8' | 'arm32v6' | 'arm32v7' | 'i386' | 'ppc64le';
type AcceptedPlatforms = 'darwin' | 'linux' | 'windows';

// Specify the command which should be used to check whether a command is 
// available on the current system
const whichCommand = os.platform() === 'win32'
    ? 'where'
    : 'which';

/**
 * Map the output from os.arch to an architecture that is supported by the
 * Postgresql binaries.
 */
function mapArchitecture(arch: string): AcceptedArchs {
    switch (arch.toString()) {
        case 'arm':
            return 'arm32v7';
        case 'arm64':
            return 'arm64v8';
        case 'x64':
            return 'amd64';
        case 'ppc64':
            return 'ppc64le';
        case 'ia32':
            return 'i386';
        default:
            throw new Error('Unsupported architecture: ' + arch);
    }
}

/**
 * Map the output from os.platform to a platform that is supported by the
 * Postgresql binaries.
 */
function mapPlatform(platform: string): AcceptedPlatforms {
    switch (platform.toString()) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'darwin';
        case 'linux':
            return 'linux';
        default:
            throw new Error('Unsupported platform ' + platform);
    }
}

/**
 * Check whether one or more binaries are available on the current system
 */
function hasBinary(bin: string | string[]): boolean {
    return (Array.isArray(bin) ? bin : [bin])
        .every((name) => {
            const output = spawnSync(whichCommand, [name], { stdio: 'inherit', shell: true });
            return output.status === 0;
        });
}

/**
 * Download the Postgresql binaries for a combination of version, architecture
 * and platform.
 * 
 * @param version The version for Postgresql that should be downloaded
 * @param arch The platform architecture for which the binary should be downloaded
 * @param platform The platform for which the binary should be downloaded
 */
export async function downloadBinaries(version: string, arch: string, platform: string) {
    // GUARD: We'll only download mismatching binaries with the current system
    // arch and platform if the "--all" flag is supplied
    if (!process.argv.includes('--all') 
        && (arch.toString() !== process.arch
        || platform.toString() !== process.platform)
    ) {
        console.log(`Skipping download for ${platform}-${arch}, because it does not match the local system (${process.platform}-${process.arch}). If you wish to download all binaries, re-run this command with the "--all" flag.`);
        return false;
    }

    // Form URL from parameters
    const mappedArch = mapArchitecture(arch);
    const mappedPlatform = mapPlatform(platform);
    const mappedVersion = coerce(version);
    const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${mappedPlatform}-${mappedArch}/${mappedVersion}/embedded-postgres-binaries-${mappedPlatform}-${mappedArch}-${mappedVersion}.jar`;

    // Download file
    const jar = await fetch(url).then((f) => {
        if (f.status !== 200) {
            throw new Error('Archive not found ' + url);
        }
        return f.arrayBuffer();
    });
    
    // Extract the archive containing the binaries from the JAR
    const unpackedJar = new AdmZip(Buffer.from(jar));
    const jarEntries = unpackedJar.getEntries();
    const archive = jarEntries.find((f) => f.entryName.endsWith('txz'));

    // GUARD: Check if the binaries archive can be found
    if (!archive) {
        const filename = url.split('/').slice(-1)[0];
        throw new Error('Could not find archive containing binaries in ' + filename);
    }

    // Store the file on disk so that we can pass it to tar
    const data = archive.getData();
    await fs.rm('native', { recursive: true }).catch(() => '');
    await fs.mkdir('native').catch(() => '');
    await fs.writeFile('native.txz', data);

    // Then extract the file with either tar, if it's available...
    // NOTE: we cannot use tar on windows because it will fuck up the symlinks
    if (os.platform() !== 'win32' && hasBinary(['tar', 'xz'])) {
        // Call tar
        const tarOutput = spawnSync('tar', ['xvf', 'native.txz', '-C', 'native'], { stdio: 'inherit' });
        
        // GUARD: Check that the output is satisfactory
        if (tarOutput.status !== 0) {
            console.error(tarOutput.output);
            throw new Error('Failed to extract tar with binaries...');
        }
    } else if (hasBinary(['7z'])) {
        // Call 7zip first, because tar on Windows hangs if it has to call a decompressor externally
        const xzOutput = spawnSync('7z', ['x', 'native.txz', '-aoa'], { stdio: 'inherit', shell: true });

        // GUARD: Check that the output is satisfactory
        if (xzOutput.status !== 0) {
            console.error(xzOutput.output);
            throw new Error('Failed to decompress tar with binaries...');
        }

        // Call tar
        const tarOutput = spawnSync('7z', ['x', 'native.tar', '-o"native"', '-aoa'], { stdio: 'inherit', shell: true });
        
        // GUARD: Check that the output is satisfactory
        if (tarOutput.status !== 0) {
            console.error(tarOutput.output);
            throw new Error('Failed to extract tar with binaries...');
        }

        // Delete the intermediate format
        await fs.unlink('native.tar');
    } else {
        // Abort to the user when unpacking utilities are missing
        throw new Error('Failed to unpack as system packages are missing. Please install both the "tar" and "xz" / "zstd" utils');
    }

    // Remove the archive
    await fs.unlink('native.txz');

    return true;
}
