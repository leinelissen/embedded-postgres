import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import crypto from 'crypto';
import { Client } from 'pg';
import getBinaries from './binary';
import AsyncExitHook from 'async-exit-hook';

const { postgres, initdb } = getBinaries();

/**
 * The options that are optionally specified for launching the Postgres database.
 */
interface PostgresOptions {
    /** The location where the data should be persisted to. Defaults to: `./data/db` */
    database_dir: string;
    /** The port where the Postgres database should be listening. Defaults to:
     *  `5432` */
    port: number;
    /** The username for logging into the Postgres database. Defaults to `postgres` */
    user: string;
    /** The password for logging into the Postgres database. Defaults to `password` */
    password: string;
    /** The authentication method to use when authenticating against Postgres.
     * Defaults to `password`  */
    auth_method: 'scram-sha-256' | 'password' | 'md5';
    /** Whether all data should be left in place when the database is shut down.
     * Defaults to true. */
    persistent: boolean;
}

// The default configuration options for the class
const defaults: PostgresOptions = {
    database_dir: path.join(process.cwd(), 'data', 'db'),
    port: 5432,
    user: 'postgres',
    password: 'password',
    auth_method: 'password',
    persistent: true,
};

/**
 * This will track instances of all current initialised clusters. We need this
 * because we want to be able to shutdown any clusters when the script is exited.
 */
const instances = new Set<EmbeddedPostgres>();

/**
 * This class creates an instance from which a single Postgres cluster is
 * managed. Note that many clusters may be created, but they will need seperate
 * data directories in order to be properly lifecycle managed.
 */
export default class EmbeddedPostgres {
    protected options: PostgresOptions;

    private process?: ChildProcess;

    constructor(options: Partial<PostgresOptions> = {}) {
        // Assign default options to options object
        this.options = Object.assign({}, defaults, options);

        instances.add(this);
    }

    /**
     * This function needs to be called whenever a Postgres cluster first needs
     * to be created. It will populate the data directory with the right
     * settings. If your Postgres cluster is already initialised, you don't need
     * to call this function again.
     */
    async initialise() {
        // Create a file on disk that contains the password in plaintext
        const randomId = crypto.randomBytes(6).readUIntLE(0,6).toString(36);
        const passwordFile = path.resolve(tmpdir(), `pg-password-${randomId}`);
        await fs.writeFile(passwordFile, this.options.password + '\n');

        // Initialize the database
        await new Promise<void>((resolve, reject) => {
            const process = spawn(initdb, [
                `--pgdata=${this.options.database_dir}`,
                `--auth=${this.options.auth_method}`,
                `--username=${this.options.user}`,
                `--pwfile=${passwordFile}`,
            ], { stdio: 'inherit' });

            process.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(`Postgres init script exited with code ${code}. Please check the logs for extra info. The data directory might already exist.`);
                }
            });
        });

        // Clean up the file
        await fs.unlink(passwordFile);
    }

    /**
     * Start the Postgres cluster with the given configuration. The cluster is
     * started as a seperate process, unmanaged by NodeJS. It is automatically
     * shut down when the script exits.
     */
    async start() {
        await new Promise<void>((resolve, reject) => {
            // Spawn a postgres server
            this.process = spawn(postgres, [
                '-D',
                this.options.database_dir,
                '-p',
                this.options.port.toString(),
            ]);

            // Connect to stderr, as that is where the messages get sent
            this.process.stderr?.on('data', (chunk: Buffer) => {
                // Parse the data as a string and log it
                const message = chunk.toString('utf-8');
                console.log(message); 

                // GUARD: Check for the right message to determine server start
                if (message.includes('database system is ready to accept connections')) {
                    resolve();
                }
            });

            // In case the process exits early, the promise is rejected.
            this.process.on('close', () => {
                reject();
            });
        });
    }

    /**
     * Stop an already started cluster with the given configuration.
     * NOTE: If you have `persisent` set to false, this method WILL DELETE your
     * database files. You will need to call `.initialise()` again after executing
     * this method.
     */
    async stop() {
        // GUARD: If no database is running, immdiately return the function.
        if (!this.process) {
            return;
        }


        // Kill the existing postgres process
        await new Promise<void>((resolve) => {
            this.process?.on('exit', resolve);
            this.process?.kill('SIGINT');
        });

        // GUARD: Additional work if database isn't persistent
        if (this.options.persistent === false) {
            // Delete the data directory
            await fs.rm(this.options.database_dir, { recursive: true, force: true });
        }
    }

    /**
     * Create a node-postgres client using the existing cluster configuration.
     * 
     * @param database The database that the postgres client should connect to
     * @param host The host that should be pre-filled in the connection options
     * @returns Client
     */
    getPgClient(database = 'postgres', host = 'localhost') {
        // Create client
        const client = new Client({
            user: this.options.user,
            password: this.options.password,
            port: this.options.port,
            host,
            database,
        });

        // Log errors rather than throwing them so that embedded-postgres has
        // enough time to actually shutdown.
        client.on('error', console.error);

        return client;
    }

    /**
     * Create a database with a given name on the cluster
     */
    async createDatabase(name: string) {
        // GUARD: Clluster must be running for performing database operations
        if (!this.process) {
            throw new Error('Your cluster must be running before you can create a database');
        }
        
        // Get client and execute CREATE DATABASE query
        const client = this.getPgClient();
        await client.connect();
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);

        // Clean up client
        await client.end();
    }

    /**
     * Drop a database with a given name on the cluster
     */
    async dropDatabase(name: string) {
        // GUARD: Clluster must be running for performing database operations
        if (!this.process) {
            throw new Error('Your cluster must be running before you can create a database');
        }

        // Get client and execute DROP DATABASE query
        const client = this.getPgClient();
        await client.connect();
        await client.query(`DROP DATABASE ${client.escapeIdentifier(name)}`);

        // Clean up client
        await client.end();
    }
}

/**
 * This script should be called when a Node script is exited, so that we can
 * nicely shutdown all potentially started clusters, and we don't end up with
 * zombie processes.
 */
async function gracefulShutdown(done: () => void) {
    // Loop through all instances, stop them, and await the response
    await Promise.all([...instances].map((instance) => {
        return instance.stop();
    }));

    // Let NodeJS know we're done
    done();
}

// Register graceful shutdown function
AsyncExitHook(gracefulShutdown);