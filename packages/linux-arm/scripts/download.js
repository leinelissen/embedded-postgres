const { downloadBinaries } = require('@embedded-postgres/downloader');
const { readSymlinks } = require('@embedded-postgres/symlink-reader')
const { version, os: [ platform ], cpu: [ arch ] } = require('../package.json');
downloadBinaries(version, arch, platform).then(readSymlinks);