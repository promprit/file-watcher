import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AdapterError, type ConnectionContext, type InterfaceScope } from '../adapter';
import { folderAdapter } from './folder.adapter';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-adapter-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeScope(overrides: Partial<InterfaceScope> = {}): InterfaceScope {
  return {
    interfaceId: 'SA-034',
    inboundPath: '.',
    filePattern: '.*\\.csv$',
    ...overrides,
  };
}

function makeContext(endpoint: string): ConnectionContext {
  return {
    connectionRef: 'folder-conn-1',
    storageType: 'FOLDER',
    endpoint,
  };
}

describe('folderAdapter.observe', () => {
  it('returns only files matching the pattern, ignoring non-matching names', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'ignore me');

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'invoice_1.csv'));
  });

  it('ignores subdirectories even if the name matches the pattern', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    fs.mkdirSync(path.join(tempDir, 'archive.csv'));

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'invoice_1.csv'));
  });

  it('returns correct size, mtime, path, and interfaceId', async () => {
    const filePath = path.join(tempDir, 'invoice_1.csv');
    fs.writeFileSync(filePath, '12345');
    const stats = fs.statSync(filePath);

    const result = await folderAdapter.observe(
      makeContext(tempDir),
      makeScope({ interfaceId: 'SA-099' })
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      interfaceId: 'SA-099',
      path: filePath,
      size: 5,
      mtime: stats.mtime,
    });
  });

  it('resolves inboundPath as a subdirectory under endpoint', async () => {
    const subDir = path.join(tempDir, 'inbound');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'invoice_1.csv'), 'a');

    const result = await folderAdapter.observe(
      makeContext(tempDir),
      makeScope({ inboundPath: 'inbound' })
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(subDir, 'invoice_1.csv'));
  });

  it('returns an empty array when the directory has no matching files', async () => {
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'ignore me');

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toEqual([]);
  });

  it('throws AdapterError when filePattern is not a valid regex', async () => {
    await expect(
      folderAdapter.observe(makeContext(tempDir), makeScope({ filePattern: '[' }))
    ).rejects.toThrow(AdapterError);
  });

  it('throws AdapterError when the directory does not exist', async () => {
    await expect(
      folderAdapter.observe(makeContext(path.join(tempDir, 'does-not-exist')), makeScope())
    ).rejects.toThrow(AdapterError);
  });

  it('skips a file that no longer exists by the time stat is called, instead of throwing', async () => {
    fs.writeFileSync(path.join(tempDir, 'ghost.csv'), 'a');
    fs.writeFileSync(path.join(tempDir, 'real.csv'), 'b');

    const realStat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (p: any, ...rest: any[]) => {
      if (String(p).endsWith('ghost.csv')) {
        const err = new Error('ENOENT: no such file or directory, stat') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return realStat(p, ...rest);
    });

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'real.csv'));
  });
});
