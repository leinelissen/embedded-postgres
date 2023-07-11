embedded-postgres / [Exports](modules.md)

# embedded-postgres
A Node package that allows you to spawn a Postgresql cluster programatically.

## Usage
```
npm i embedded-postgres
```

```ts
import EmbeddedPostgres from 'embedded-postgres';

async function main() {
    // Create the object
    const pg = new EmbeddedPostgres({
        databaseDir: './data/db',
        user: 'postgres',
        password: 'password',
        port: 5432,
        persistent: true,
    });

    // Create the cluster config files
    await pg.inititialize();

    // Start the server
    await pg.start();

    // Create and/or drop database
    await pg.createDatabase('TEST');
    await pg.dropDatabase('TEST');

    // Initialize a node-postgres client
    const client = pg.getPgClient();
    await client.connect();
    const result = await client.query('SELECT datname FROM pg_database');

    // Stop the server
    await pg.stop();
}

main();
```

## Credits
Embedded Postgres was created by Lei Nelissen for [BMD
Studio](https://bmd.studio). It is based on [zonky's embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres).
