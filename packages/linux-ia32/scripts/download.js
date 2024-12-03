import { downloadBinaries } from '@embedded-postgres/downloader';
import { readSymlinks } from '@embedded-postgres/symlink-reader';
import packageJson from '../package.json' with { type: "json" };
downloadBinaries(process.argv, packageJson).then(readSymlinks);