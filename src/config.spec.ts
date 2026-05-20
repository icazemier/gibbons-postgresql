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
});
