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
                    throw new Error('Unsupported arch: ' + arch);
            }
        default:
            throw new Error('Unsupported platform: ' + platform);
    }
}

export default getBinaries;