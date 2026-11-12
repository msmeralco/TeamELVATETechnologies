// Removes the local mock-chain file. The database is Postgres: use the admin "Reset demo data" button.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'data');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}`);
