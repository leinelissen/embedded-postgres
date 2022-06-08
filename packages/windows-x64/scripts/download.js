const { downloadBinaries } = require('@embedded-postgres/downloader');
const { version, os: [ platform ], cpu: [ arch ] } = require('../package.json');
downloadBinaries(version, arch, platform);