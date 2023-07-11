import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { tmpdir, userInfo } from 'os';
import { ChildProcess, spawn, exec } from 'child_process';

import { Client } from 'pg';
import AsyncExitHook from 'async-exit-hook';

import getBinaries from './binary';
import { PostgresOptions } from './types';

const { postgres, initdb } = getBinaries();

/**
 * Previosuly, options were specified in snake_case rather than camelCase. Old
 * options are still translated to new variants.
 */
interface LegacyOptions {
    database_dir: string;
    auth_method: 'scram-sha-256' | 'password' | 'md5';
}

// The default configuration options for the class
const defaults: PostgresOptions = {
    databaseDir: path.join(process.cwd(), 'data', 'db'),
    port: 5432,
    user: 'postgres',
    password: 'password',
    authMethod: 'password',
    persistent: true,
    initdbFlags: [],
    postgresFlags: [],
    createPostgresUser: false,
    onLog: console.log,
    onError: console.error,
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
class EmbeddedPostgres {
    protected options: PostgresOptions;

    private process?: ChildProcess;

    private isRootUser: boolean;

    constructor(options: Partial<PostgresOptions> = {}) {
        // Options were previously specified in snake_case rather than
        // camelCase. We still want to accept the old style of options.
        const legacyOptions: Partial<PostgresOptions> = {};
        if ((options as LegacyOptions).database_dir) { 
            legacyOptions.databaseDir = (options as LegacyOptions).database_dir; 
        }
        if ((options as LegacyOptions).auth_method) { 
            legacyOptions.authMethod = (options as LegacyOptions).auth_method; 
        }

        // Assign default options to options object
        this.options = Object.assign({}, defaults, legacyOptions, options);

        instances.add(this);

        this.isRootUser = userInfo().uid === 0;
    }

    /**
     * This function needs to be called whenever a Postgres cluster first needs
     * to be created. It will populate the data directory with the right
     * settings. If your Postgres cluster is already initialised, you don't need
     * to call this function again.
     */
    async initialise() {
        // GUARD: Check that a postgres user is available 
        await this.checkForRootUser();

        // Optionally retrieve the uid and gid
        let permissionIds = await this.getUidAndGid()
            .catch(() => ({}));

        // GUARD: Check if we need to create users
        if (this.options.createPostgresUser 
            && !('uid' in permissionIds) 
            && !('gid' in permissionIds)
        ) {
            try {
                // Create the group and user
                await execAsync('groupadd postgres');
                await execAsync('useradd -g postgres postgres');

                // Re-treieve the permission ids now the user exists
                permissionIds = await this.getUidAndGid();
            } catch (err) {
                this.options.onError(err);
                throw new Error('Failed to create and initialize a new user on this system.');
            }
        }

        // GUARD: Ensure that the data directory is owned by the created user
        if (this.options.createPostgresUser) {
            if (!('uid' in permissionIds)) {
                throw new Error('Failed to retrieve the uid for the newly created user.');
            }

            // Create the data directory and have the user own it, so we
            // don't get any permission errors
            await fs.mkdir(this.options.databaseDir, { recursive: true });
            await fs.chown(this.options.databaseDir, permissionIds.uid, permissionIds.gid);
        }

        // Create a file on disk that contains the password in plaintext
        const randomId = crypto.randomBytes(6).readUIntLE(0,6).toString(36);
        const passwordFile = path.resolve(tmpdir(), `pg-password-${randomId}`);
        await fs.writeFile(passwordFile, this.options.password + '\n');

        // Greedily make the file executable, in case it is not
        await fs.chmod(postgres, '755');
        await fs.chmod(initdb, '755');

        // Initialize the database
        await new Promise<void>((resolve, reject) => {
            const process = spawn(initdb, [
                `--pgdata=${this.options.databaseDir}`,
                `--auth=${this.options.authMethod}`,
                `--username=${this.options.user}`,
                `--pwfile=${passwordFile}`,
                ...this.options.initdbFlags,
            ], { stdio: 'inherit', ...permissionIds });

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
        // Optionally retrieve the uid and gid
        const permissionIds = await this.getUidAndGid()
            .catch(() => { 
                throw new Error('Postgres cannot run as a root user. embedded-postgres could not find a postgres user to run as instead. Consider using the `createPostgresUser` option.'); 
            });

        // Greedily make the file executable, in case it is not
        await fs.chmod(postgres, '755');

        await new Promise<void>((resolve, reject) => {

            // Spawn a postgres server
            this.process = spawn(postgres, [
                '-D',
                this.options.databaseDir,
                '-p',
                this.options.port.toString(),
                ...this.options.postgresFlags,
            ], { ...permissionIds });

            // Connect to stderr, as that is where the messages get sent
            this.process.stderr?.on('data', (chunk: Buffer) => {
                // Parse the data as a string and log it
                const message = chunk.toString('utf-8');
                this.options.onLog(message); 

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

        // GUARD: Additional work if database is not persistent
        if (this.options.persistent === false) {
            // Delete the data directory
            await fs.rm(this.options.databaseDir, { recursive: true, force: true });
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
        client.on('error', this.options.onError);

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

    /**
     * Warn the user in case they're trying to run this library as a root user
     */
    private async checkForRootUser() {
        // GUARD: Ensure that the user isn't root
        if (!this.isRootUser) {
            return;
        }

        // Attempt to retrieve the uid and gid for the postgres user. This check
        // will throw and error when the postgres user doesn't exist
        try {
            await this.getUidAndGid();
        } catch (err) {
            // GUARD: No user exists, but check that a postgres user should be created
            if (!this.options.createPostgresUser) {
                throw new Error('You are running this script as root. Postgres does not support running as root. If you wish to continue, configure embedded-postgres to create a Postgres user by setting the `createPostgresUser` option to true.');
            }
        }
    }

    /**
     * Retrieve the uid and gid for a particular user
     */
    private async getUidAndGid(name = 'postgres') {
        if (!this.isRootUser) {
            return {} as Record<string, never>;
        }

        const [uid, gid] = await Promise.all([
            execAsync(`id -u ${name}`).then(Number.parseInt),
            execAsync(`id -g ${name}`).then(Number.parseInt),
        ]);

        return { uid, gid };
    }
}

/**
 * A promisified version of the exec API that either throws on errors or returns
 * the string results from the executed command.
 */
async function execAsync(command: string) {
    return new Promise<string>((resolve, reject) => {
        exec(command, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
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

export = EmbeddedPostgres;