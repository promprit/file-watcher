import { WatcherState } from './watcher-state';

/**
 * StateRepository defines the contract for database operations on WatcherState.
 * Implementations persist and retrieve file state from the watcher_state table.
 *
 * This is an abstract repository interface that the database layer implements.
 * All database access for file state goes through this interface.
 */
export interface StateRepository {
  /**
   * Retrieve a single WatcherState by its composite key.
   *
   * @param interfaceId - The interface monitoring this file
   * @param filePath - The full path to the file
   * @returns The WatcherState if found, null if not found
   */
  get(interfaceId: string, filePath: string): Promise<WatcherState | null>;

  /**
   * Persist or update a WatcherState record.
   * Creates a new record if it doesn't exist, updates if it does.
   *
   * @param state - The WatcherState to save
   * @throws If the database operation fails
   */
  save(state: WatcherState): Promise<void>;

  /**
   * Retrieve all WatcherState records for a given interface.
   * Used to query all files monitored by an interface.
   *
   * @param interfaceId - The interface to query
   * @returns Array of WatcherState records for the interface (empty if none found)
   */
  findByInterface(interfaceId: string): Promise<WatcherState[]>;
}
