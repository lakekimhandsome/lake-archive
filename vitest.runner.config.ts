import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/runner.test.ts'], environment: 'node' } });
