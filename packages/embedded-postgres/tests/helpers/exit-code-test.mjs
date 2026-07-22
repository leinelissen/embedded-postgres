import EmbeddedPostgres from '../../dist/index.js';

const pg = new EmbeddedPostgres({
    port: 15433,
    databaseDir: '/tmp/ep-exit-code-test',
    persistent: false,
    onLog: () => {},
});

process.exitCode = 42;
