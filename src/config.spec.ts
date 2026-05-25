import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigLoader } from './config.js';

describe('ConfigLoader', () => {
  it('Load sample config', async () => {
    const config = await ConfigLoader.load('gibbons-postgresql-sample');
    expect(config).toBeTruthy();
  });

  it('Load faulty config', async () => {
    await expect(
      ConfigLoader.load('gibbons-postgresql-sampleeeee')
    ).rejects.toThrow(
      'Could not load config, execute `npx gibbons-postgresql init`'
    );
  });

  it('loads config from an explicit filepath', async () => {
    const filepath = path.resolve('.gibbons-postgresql-samplerc.json');
    const config = await ConfigLoader.load('gibbons-postgresql', filepath);
    expect(config).toBeTruthy();
  });

  it('rejects filepaths containing null bytes', async () => {
    await expect(
      ConfigLoader.load('gibbons-postgresql', '/tmp/config\0evil.json')
    ).rejects.toThrow('null bytes are not allowed');
  });
});
