import path from 'path';
import { fileURLToPath } from 'url';
    
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const pg_ctl = path.resolve(__dirname, '..', 'native', 'bin', 'pg_ctl.exe');
export const initdb = path.resolve(__dirname, '..', 'native', 'bin', 'initdb.exe');
export const postgres = path.resolve(__dirname, '..', 'native', 'bin', 'postgres.exe');

