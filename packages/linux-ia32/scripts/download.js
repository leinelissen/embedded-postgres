const { downloadBinaries } = require('@embedded-postgres/downloader');
const { readSymlinks } = require('@embedded-postgres/symlink-reader')
const { version, os: [ platform ], cpu: [ arch ] } = require('../package.json');
downloadBinaries(process.argv[2] || version, arch, platform).then(readSymlinks);