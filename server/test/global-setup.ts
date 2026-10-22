import { execSync } from 'node:child_process';
import fs from 'node:fs';

export default function setup() {
  execSync('npx prisma db push --force-reset --skip-generate', {
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'ignore',
  });
  fs.rmSync('./test-uploads', { recursive: true, force: true });
}
