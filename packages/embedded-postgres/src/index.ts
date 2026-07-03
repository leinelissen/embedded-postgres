import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { platform, tmpdir, userInfo } from 'os';
import { ChildProcess, spawn, exec, execSync } from 'child_process';

import pg from 'pg';
import AsyncExitHook from 'async-exit-hook';

import getBinaries from './binary.js';
import { PostgresOptions } from './types.js';

const bin = getBinaries();
const { Client } = pg;

const POSTGRES_READY_POLL_INTERVAL_MS = 250;
const POSTGRES_READY_TIMEOUT_MS = 300_000;

/**
 * We have to specify the LC_MESSAGES locale because we rely on inspecting the
 * output of the `initdb` command to see if Postgres is ready. As we're looking
 * for a particular string, we need to force that string into the right locale.
 * @see https://github.com/leinelissen/embedded-postgres/issues/15
 */
function getBestLocale(): string {
    // `locale -a` is not available on Windows.
    if (platform() === 'win32') {
        return 'C';
    }
    try {
        const availableLocales = new Set(
            execSync('locale -a', { encoding: 'utf-8' })
                .split(/\r?\n/)
                .map((locale) => locale.trim())
                .filter(Boolean)
        );
        if (availableLocales.has('en_US.UTF-8')) return 'en_US.UTF-8';
        if (availableLocales.has('C.UTF-8')) return 'C.UTF-8';
        if (availableLocales.has('en_US.utf8')) return 'en_US.utf8';
    } catch {
        // Fallback to POSIX C locale
    }
    return 'C';
}

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
    lifecycleMode: 'managed',
    initdbFlags: [],
    postgresFlags: [],
    createPostgresUser: false,
    onLog: console.log,
    onError: console.error,
};

// Fixes the mode of files that are supposed to be executable
//                        r-xr-xr-x
const BIN_PERMISSIONS = 0b101101101;
const ensureBinIsExecutable = async (filePath: string) => {
    // Only fix the file's mode if it's missing a permission. This is useful
    // when the binaries are in a read-only file system, as a call to chmod
    // (even unnecessary) would cause a crash.
    const stat = await fs.stat(filePath);

    if ((stat.mode & BIN_PERMISSIONS) !== BIN_PERMISSIONS) {
        await fs.chmod(filePath, stat.mode | BIN_PERMISSIONS);
    }
};


const quoteWindowsCommandLineArgument = (value: string) => {
    const stringValue = String(value);
    if (!/[ \t\n\v"]/.test(stringValue)) {
        return stringValue;
    }

    return `"${stringValue
        .replace(/(\\*)"/g, '$1$1\\"')
        .replace(/(\\+)$/g, '$1$1')}"`;
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

    private detachedPostmasterPid?: number;

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

        if (this.options.lifecycleMode === 'managed') {
            instances.add(this);
        }

        this.isRootUser = userInfo().uid === 0;
    }

    /**
     * This function needs to be called whenever a Postgres cluster first needs
     * to be created. It will populate the data directory with the right
     * settings. If your Postgres cluster is already initialised, you don't need
     * to call this function again.
     */
    async initialise() {
        const { postgres, initdb } = await bin;
        const locale = getBestLocale();

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

        // Make the files executable, in case they are not
        ensureBinIsExecutable(postgres);
        ensureBinIsExecutable(initdb);

        // Initialize the database
        try {
            await new Promise<void>((resolve, reject) => {
                const childProcess = spawn(initdb, [
                    `--pgdata=${this.options.databaseDir}`,
                    `--auth=${this.options.authMethod}`,
                    `--username=${this.options.user}`,
                    `--pwfile=${passwordFile}`,
                    `--lc-messages=${locale}`,
                    ...this.options.initdbFlags,
                ], {
                    ...permissionIds,
                    env: {
                        ...process.env,
                        LC_MESSAGES: locale,
                    },
                });

                // Connect to stderr, as that is where the messages get sent
                let stderrOutput = '';
                childProcess.stdout?.on('data', (chunk: Buffer) => {
                    const message = chunk.toString('utf-8');
                    this.options.onLog(message);
                });

                childProcess.stderr?.on('data', (chunk: Buffer) => {
                    const message = chunk.toString('utf-8');
                    stderrOutput += message;
                    this.options.onLog(`[STDERR] ${message}`);
                });

                childProcess.on('close', (code, signal) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Postgres init script failed (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}). ERROR OUTPUT: ${stderrOutput}`));
                    }
                });
            });
        } finally {
            // Clean up the file even when initdb fails
            await fs.unlink(passwordFile).catch(() => undefined);
        }
    }

    /**
     * Start the Postgres cluster with the given configuration. Managed clusters
     * keep the historical parent-process lifecycle and are automatically shut
     * down when the script exits. Detached clusters are isolated from the parent
     * lifecycle and must be stopped explicitly.
     */
    async start() {
        const { postgres } = await bin;
        const locale = getBestLocale();

        // Optionally retrieve the uid and gid
        const permissionIds = await this.getUidAndGid()
            .catch(() => { 
                throw new Error('Postgres cannot run as a root user. embedded-postgres could not find a postgres user to run as instead. Consider using the `createPostgresUser` option.'); 
            });

        // Make the file executable, in case it is not
        ensureBinIsExecutable(postgres);

        if (this.options.lifecycleMode === 'detached') {
            if (platform() === 'win32') {
                await this.startDetachedWindows(postgres, locale);
            } else {
                await this.startDetachedPosix(postgres, locale, permissionIds);
            }
            await this.waitUntilReady();
            return;
        }

        await new Promise<void>((resolve, reject) => {
            // Spawn a postgres server
            this.process = spawn(postgres, [
                '-D',
                this.options.databaseDir,
                '-p',
                this.options.port.toString(),
                ...this.options.postgresFlags,
            ], {
                ...permissionIds,
                env: {
                    ...process.env,
                    LC_MESSAGES: locale,
                },
            });

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

    private async startDetachedPosix(
        postgres: string,
        locale: string,
        permissionIds: Record<string, never> | { uid: number; gid: number }
    ) {
        await new Promise<void>((resolve, reject) => {
            this.process = spawn(postgres, [
                '-D',
                this.options.databaseDir,
                '-p',
                this.options.port.toString(),
                ...this.options.postgresFlags,
            ], {
                ...permissionIds,
                detached: true,
                env: {
                    ...process.env,
                    LC_MESSAGES: locale,
                },
            });

            this.process.stderr?.on('data', (chunk: Buffer) => {
                this.options.onLog(chunk.toString('utf-8'));
            });

            this.process.once('error', reject);
            this.process.once('spawn', resolve);

            this.process.unref();
            (this.process.stdin as { unref?: () => void } | null)?.unref?.();
            (this.process.stdout as { unref?: () => void } | null)?.unref?.();
            (this.process.stderr as { unref?: () => void } | null)?.unref?.();
        });
    }

    private async startDetachedWindows(postgres: string, locale: string) {
        const commandLine = [
            postgres,
            '-D',
            this.options.databaseDir,
            '-p',
            this.options.port.toString(),
            ...this.options.postgresFlags,
        ].map(quoteWindowsCommandLineArgument).join(' ');

        const launcher = [
            '$source = @\'',
            'using System;',
            'using System.Text;',
            'using System.Runtime.InteropServices;',
            'public static class EmbeddedPostgresLauncher {',
            '  [StructLayout(LayoutKind.Sequential)] public struct StartupInfo { public int cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title; public int x; public int y; public int xSize; public int ySize; public int xCountChars; public int yCountChars; public int fillAttribute; public int flags; public short showWindow; public short reserved2; public IntPtr reserved3; public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError; }',
            '  [StructLayout(LayoutKind.Sequential)] public struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }',
            '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);',
            '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);',
            '}',
            '\'@',
            'Add-Type -TypeDefinition $source',
            '$startupInfo = New-Object EmbeddedPostgresLauncher+StartupInfo',
            '$startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][EmbeddedPostgresLauncher+StartupInfo])',
            '$processInformation = New-Object EmbeddedPostgresLauncher+ProcessInformation',
            '$commandLine = New-Object System.Text.StringBuilder',
            '[void]$commandLine.Append($env:EMBEDDED_POSTGRES_COMMAND_LINE)',
            '# CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT',
            '$started = [EmbeddedPostgresLauncher]::CreateProcessW([NullString]::Value, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x08000400, [IntPtr]::Zero, [NullString]::Value, [ref]$startupInfo, [ref]$processInformation)',
            'if (-not $started) { Write-Output ("LAUNCH_ERR " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }',
            '[void][EmbeddedPostgresLauncher]::CloseHandle($processInformation.process)',
            '[void][EmbeddedPostgresLauncher]::CloseHandle($processInformation.thread)',
            'Write-Output ("LAUNCH_PID " + $processInformation.processId)',
        ].join('\n');

        await new Promise<void>((resolve, reject) => {
            const launcherProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
                windowsHide: true,
                env: {
                    ...process.env,
                    LC_MESSAGES: locale,
                    EMBEDDED_POSTGRES_COMMAND_LINE: commandLine,
                },
            });
            let stdout = '';

            launcherProcess.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf-8');
            });
            launcherProcess.stderr?.on('data', (chunk: Buffer) => {
                this.options.onError(chunk.toString('utf-8'));
            });
            launcherProcess.once('error', reject);
            launcherProcess.once('close', (code) => {
                const pidMatch = stdout.match(/LAUNCH_PID (\d+)/);
                if (code === 0 && pidMatch) {
                    this.detachedPostmasterPid = Number(pidMatch[1]);
                    this.process = undefined;
                    resolve();
                    return;
                }

                reject(new Error(`Postgres detached launch failed (${stdout.trim() || `powershell exit ${code}`})`));
            });
        });
    }

    private async waitUntilReady() {
        const startedAt = Date.now();

        while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
            if (this.process !== undefined && (this.process.exitCode !== null || this.process.signalCode !== null)) {
                throw new Error(`Postgres process exited before becoming ready on port ${this.options.port}`);
            }
            if (platform() === 'win32' && this.detachedPostmasterPid !== undefined) {
                try {
                    process.kill(this.detachedPostmasterPid, 0);
                } catch {
                    throw new Error(`Postgres process exited before becoming ready on port ${this.options.port}`);
                }
            }

            const client = new Client({
                user: this.options.user,
                password: this.options.password,
                port: this.options.port,
                host: 'localhost',
                database: 'postgres',
                connectionTimeoutMillis: 2000,
            });
            client.on('error', () => undefined);

            try {
                await client.connect();
                await client.query('SELECT 1');
                await client.end().catch(() => undefined);
                return;
            } catch {
                await client.end().catch(() => undefined);
                await new Promise<void>((resolve) => setTimeout(resolve, POSTGRES_READY_POLL_INTERVAL_MS));
            }
        }

        throw new Error(`Postgres cluster on port ${this.options.port} did not become ready within ${POSTGRES_READY_TIMEOUT_MS}ms`);
    }

    private isStarted() {
        return this.process !== undefined || this.detachedPostmasterPid !== undefined;
    }

    private async waitUntilWindowsProcessStops(pid: number) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < 15_000) {
            const taskListOutput = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`).catch(() => '');
            if (!new RegExp(`\\s${pid}\\s`).test(taskListOutput)) {
                return;
            }

            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
    }

    /**
     * Stop an already started cluster with the given configuration.
     * NOTE: If you have `persisent` set to false, this method WILL DELETE your
     * database files. You will need to call `.initialise()` again after executing
     * this method.
     */
    async stop() {
        const pid = this.detachedPostmasterPid ?? this.process?.pid;

        // GUARD: If no database is running, immdiately return the function.
        if (!this.isStarted()) {
            return;
        }

        // Kill the existing postgres process
        if (platform() === 'win32') {
            if (!pid) {
                throw new Error('Could not find process PID');
            }

            await new Promise<void>((resolve) => {
                const killer = spawn('taskkill', ['/pid', pid.toString(), '/f', '/t'], {
                    windowsHide: true,
                });
                killer.on('error', () => resolve());
                killer.on('close', () => resolve());
            });
            await this.waitUntilWindowsProcessStops(pid);
        } else {
            await new Promise<void>((resolve) => {
                // Register a handler for when the process finally exists
                this.process?.on('exit', resolve);

                // If on a sane OS, simply kill using SIGINT
                this.process?.kill('SIGINT');
            });
        }

        // Clean up process
        this.process = undefined;
        this.detachedPostmasterPid = undefined;

        // GUARD: Additional work if database is not persistent
        if (this.options.persistent === false) {
            // Delete the data directory
            await fs.rm(this.options.databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
        // GUARD: Cluster must be running for performing database operations
        if (!this.isStarted()) {
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
        // GUARD: Cluster must be running for performing database operations
        if (!this.isStarted()) {
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

export default EmbeddedPostgres;