import { downloadBinaries } from '@embedded-postgres/downloader';
import { readSymlinks } from '@embedded-postgres/symlink-reader';
import packageJson from '../package.json' assert { type: "json" };
const { version, cpu, os } = packageJson;
downloadBinaries(process.argv[2] || version, cpu, os).then(readSymlinks);