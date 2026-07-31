import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileObservation } from '@packages/contracts';
import { AdapterError, type Adapter, type ConnectionContext, type InterfaceScope } from '../adapter';

export const folderAdapter: Adapter = {
  async observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]> {
    const resolvedPath = path.join(context.endpoint, scope.inboundPath);

    let entries: string[];
    try {
      entries = await fs.readdir(resolvedPath);
    } catch (cause) {
      throw new AdapterError(context.connectionRef, scope.interfaceId, cause);
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(scope.filePattern);
    } catch (cause) {
      throw new AdapterError(context.connectionRef, scope.interfaceId, cause);
    }
    const matches = entries.filter((name) => pattern.test(name));

    const observations: FileObservation[] = [];
    for (const name of matches) {
      const fullPath = path.join(resolvedPath, name);

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw new AdapterError(context.connectionRef, scope.interfaceId, cause);
      }

      if (!stats.isFile()) {
        continue;
      }

      observations.push({
        interfaceId: scope.interfaceId,
        path: fullPath,
        size: stats.size,
        mtime: stats.mtime,
      });
    }

    return observations;
  },
};
