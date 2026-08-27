import { test } from 'node:test';

test('probe path binding order', async () => {
  process.env.BROKE_CONFIG_PATH = 'Z:/probe/config.json';
  const { CONFIG_PATH } = await import('../config');
  console.log('CONFIG_PATH resolved:', CONFIG_PATH);
});
