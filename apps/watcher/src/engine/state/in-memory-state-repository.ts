import type { StateRepository, WatcherState } from '@packages/contracts';

export class InMemoryStateRepository implements StateRepository {
  private readonly store = new Map<string, WatcherState>();

  private key(interfaceId: string, filePath: string): string {
    return `${interfaceId}::${filePath}`;
  }

  async get(interfaceId: string, filePath: string): Promise<WatcherState | null> {
    return this.store.get(this.key(interfaceId, filePath)) ?? null;
  }

  async save(state: WatcherState): Promise<void> {
    this.store.set(this.key(state.interfaceId, state.filePath), state);
  }

  async findByInterface(interfaceId: string): Promise<WatcherState[]> {
    return Array.from(this.store.values()).filter((s) => s.interfaceId === interfaceId);
  }
}
