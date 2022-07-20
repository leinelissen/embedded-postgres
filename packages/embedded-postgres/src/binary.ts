import os from 'os';

type Binaries = {
    postgres: string;
    pg_ctl: string;
    initdb: string;
}

function getBinaries(): Binaries {
    const arch = os.arch();
    const platform = os.platform();
    
    switch (platform) {
        case 'darwin':
            switch(arch) {
                case 'arm64':
                    return require('@embedded-postgres/darwin-arm64');
                case 'x64':
                    return require('@embedded-postgres/darwin-x64');
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);
            }
        case 'linux':
            switch(arch) {
                case 'arm64':
                    return require('@embedded-postgres/linux-arm64');
                case 'arm':
                    return require('@embedded-postgres/linux-arm');
                case 'ia32':
                    return require('@embedded-postgres/linux-ia32');
                case 'ppc64':
                    return require('@embedded-postgres/linux-ppc64');
                case 'x64':
                    return require('@embedded-postgres/linux-x64');
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);    
            }
        case 'win32':
            switch(arch) {
                case 'x64':
                    return require('@embedded-postgres/windows-x64');
                default:
                    throw new Error(`Unsupported arch "${arch}" for platform "${platform}"`);
            }
        default:
            throw new Error(`Unsupported platform "${platform}"`);
    }
}

export default getBinaries;