![Embedded Postgres](https://github.com/leinelissen/embedded-postgres/raw/main/docs/images/embedded-postgres-header.svg)

<div align="center">

![npm](https://img.shields.io/npm/v/@embedded-postgres/linux-x64)
![npm type definitions](https://img.shields.io/npm/types/@embedded-postgres/linux-x64)
![npm](https://img.shields.io/npm/dy/@embedded-postgres/linux-x64)
![NPM](https://img.shields.io/npm/l/@embedded-postgres/linux-x64)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/leinelissen/embedded-postgres/test.yml)

</div>

<h3 align="center">
    🐘 A Node package that spawns PostgresQL clusters programatically.
</h3>

This package contains the `linux-x64` Postgres binaries for use with the `embedded-postgres`
package. See
[embedded-postgres](https://github.com/leinelissen/embedded-postgres) for a more
developer-friendly way of spawning PostgresQL clusters.

## Installation
`embedded-postgres` is available from NPM:

```sh
npm i embedded-postgres
```

<br />

## Using just the binaries
If you just want to use the binaries, you can also just use this package
directly. It exports the paths to the
[`pg_ctl`](https://www.postgresql.org/docs/current/app-pg-ctl.html),
[`initdb`](https://www.postgresql.org/docs/current/app-initdb.html) and
[`postgres`](https://www.postgresql.org/docs/current/app-postgres.html) binaries
for `linux-x64`.

```sh
npm i @embedded-postgres/linux-x64
```


Follow the documentation to discover how to interface with the binaries. Any implementation is going to look something like this:
```ts
import { pg_ctl, initdb, postgres } from '@embedded-postgres/linux-x64'
import { execSync, spawn } from 'child_process';

execSync(initdb);
spawn(postgres);
```

> [!IMPORTANT]  
> A more friendly wrapper for using these binaries is provided as the
> [embedded-postgres](https://github.com/leinelissen/embedded-postgres) package.
> Please use it if you're confused by the binaries.

## Credits and Licensing
Embedded Postgres was created by Lei Nelissen for [BMD
Studio](https://bmd.studio). It is based on [zonky's
embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres). The
binaries are made available under the Apache License 2.0, whereas the specific
code in this package is made available under the MIT license.

<a href="https://bmd.studio">
    <img src="https://github.com/leinelissen/embedded-postgres/raw/main/docs/images/logo-bmd.svg" alt="BMD Studio" width="150" height="150" />
</a>

<br />
