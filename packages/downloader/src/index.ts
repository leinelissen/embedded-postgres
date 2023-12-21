import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';

type AcceptedArchs = 'amd64' | 'arm64v8' | 'arm32v6' | 'arm32v7' | 'i386' | 'ppc64le';
type AcceptedPlatforms = 'darwin' | 'linux' | 'windows';

/**
 * Map the output from os.arch to an architecture that is supported by the
 * Postgresql binaries.
 */
function mapArchitecture(arch: string): AcceptedArchs {
    switch (arch) {
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
    switch (platform) {
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
 * Download the Postgresql binaries for a combination of version, architecture
 * and platform.
 * 
 * @param version The version for Postgresql that should be downloaded
 * @param arch The platform architecture for which the binary should be downloaded
 * @param platform The platform for which the binary should be downloaded
 */
export async function downloadBinaries(version: string, arch: string, platform: string) {
    // Form URL from parameters
    const mappedArch = mapArchitecture(arch);
    const mappedPlatform = mapPlatform(platform);
    const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${mappedPlatform}-${mappedArch}/${version}/embedded-postgres-binaries-${mappedPlatform}-${mappedArch}-${version}.jar`;

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

    // Then extract the file with tar
    spawnSync('tar', ['xvf', 'native.txz', '-C', 'native'], { stdio: 'inherit' });
    await fs.unlink('native.txz');
}
