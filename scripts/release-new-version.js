const lernaRun = require('@lerna/run');
const lernaVersion = require('@lerna/version');
const lernaPublish = require('@lerna/publish');

/**
 * Define a static set of versions that are supported. This means that only new
 * binaries for thesse versions will be released.
 */
const supportedVersions = [
    '10.20.0',
    '11.15.0',
    '12.10.0',
    '13.6.0',
    '14.3.0',
    '14.4.0',
    '14.5.0',
    '15.0.0',
];

/**
 * Accept a particular affix that should appended to the version number. The
 * affix will be automatically prefixed with `-`
 */
const affix = process.argv[2] ? `-${process.argv[2]}` : '';

/**
 * Main executor function
 */
async function main() {
    // Loop through each supported version
    for await (let pgVersion of supportedVersions) {
        // Create version number from pgVersion and affix
        const version = `${pgVersion}${affix}`;

        // Log start
        console.log(`🔄 Processing v${version}...`);

        // Download the new versions in all repositories
        await lernaRun({
            cwd: process.cwd(),
            script: 'download',
            '--': [pgVersion],
        });

        // Release the newly downloaded releases
        await lernaVersion({
            cwd: process.cwd(),
            bump: version,
            yes: true,
            forcePublish: true,
        });

        // Publish the packages
        await lernaPublish({
            cwd: process.cwd(),
            bump: 'from-package',
            yes: true,
        });
        
        // Log success
        console.log(`✅ Processing v${version} complete.`)
    }
}

main();
