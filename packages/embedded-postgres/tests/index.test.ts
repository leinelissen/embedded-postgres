import { it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import EmbeddedPostgres from '../src/index.js';
import { PostgresOptions } from '../src/types.js';
import { beforeEach } from 'node:test';

const DB_NAME = 'embedded-pg-test-db';
const DB_PATH = path.join(__dirname, 'data', 'db');

const DEFAULT_SETTINGS: Partial<PostgresOptions> = {
    port: 5433,
    databaseDir: DB_PATH,
};

let pg: EmbeddedPostgres | undefined;

beforeEach(async () => {
    // Reset the client
    pg = undefined;

    //
});

afterEach(async () => {
    // Stop client
    await pg?.stop();
    
    // Remove all cluster files
    await fs.rm(path.join(DB_PATH), { recursive: true, force: true });
});

it('should be able to initialise a cluster', async () => {
    // Initialise and stop a basic cluster
    pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
    await pg.initialise();

    // Check that the database files have been created
    const stat = await fs.stat(
        path.join(DB_PATH, 'pg_hba.conf')
    );
    expect(stat.isFile()).toBe(true);
});

it('should be able to start and stop a cluster', async () => {
    pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
    await pg.initialise();

    await pg.start();
});

// it('should throw an error if the cluster is attempted to be started without initialising', async () => {
//     pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
//     try {
//         await pg.start();
//     } catch (e) {
//         expect(e instanceof Error).toBe(true);
//         expect((e as Error).message).toBe('Cannot start cluster if it has not been initialised first.');
//     }
// });

it('should allow the creation of pg clients', async () => {
    // Initialise and start a basic cluster
    pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
    await pg.initialise();
    await pg.start();

    // Create and connect a database client
    const client = pg.getPgClient();
    await client.connect();

    // Check if it can query the database
    const result = await client.query('SELECT datname FROM pg_database;');
    expect(result.rows.map((r) => r.datname)).toContain('postgres');
});

it('should allow creating databases', async () => {
    // Initialise and start a basic cluster
    pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
    await pg.initialise();
    await pg.start();

    // Create the database
    await pg.createDatabase(DB_NAME);

    // Connect the client
    const client = pg.getPgClient();
    await client.connect();

    // Retrieve database names and check whether the database has been created
    const result = await client.query('SELECT datname FROM pg_database;');
    expect(result.rows.map((r) => r.datname)).toContain(DB_NAME);
});

it('should allow deleting databases', async () => {
    // Initialise and start a basic cluster
    pg = new EmbeddedPostgres(DEFAULT_SETTINGS);
    await pg.initialise();
    await pg.start();

    // Create the database
    await pg.createDatabase(DB_NAME);

    // Connect the client
    const client = pg.getPgClient();
    await client.connect();

    // Retrieve database names and check whether the database has been created
    let result = await client.query('SELECT datname FROM pg_database;');
    expect(result.rows.map((r) => r.datname)).toContain(DB_NAME);

    // Delete the database
    await pg.dropDatabase(DB_NAME);
    result = await client.query('SELECT datname FROM pg_database;');
    expect(result.rows.map((r) => r.datname)).not.toContain(DB_NAME);
});

it('should automatically remove files when persistent is set to false', async () => {
    // Initialise and start a basic cluster
    pg = new EmbeddedPostgres({ ...DEFAULT_SETTINGS, persistent: false });
    await pg.initialise();
    await pg.start();
    
    // Check that the database files have been created
    const stat = await fs.stat(
        path.join(DB_PATH, 'pg_hba.conf')
    );
    expect(stat.isFile()).toBe(true);

    // Auto-delete the database by stopping the cluster
    await pg.stop();

    // Check that the database files have been delete
    expect(() => fs.stat(path.join(DB_PATH, 'pg_hba.conf')))
        .rejects
        .toThrowError();
});