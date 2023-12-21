import { downloadBinaries } from '@embedded-postgres/downloader';
import { readSymlinks } from '@embedded-postgres/symlink-reader';
import { version, os, cpu } from '../package.json';
downloadBinaries(process.argv[2] || version, cpu.arch, os.platform).then(readSymlinks);