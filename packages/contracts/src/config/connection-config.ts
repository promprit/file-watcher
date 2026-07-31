/**
 * ConnectionConfig defines the connection parameters needed to reach a source system.
 * This includes authentication, endpoint, and timeout configuration.
 *
 * Minimal version for database layer use - contains only configuration data,
 * no connection logic or credential secrets.
 */
export interface ConnectionConfig {
  /**
   * Unique identifier for this connection configuration.
   * Used as the primary key in the connections table.
   * Referenced by InterfaceConfig.connectionRef.
   */
  connectionRef: string;

  /**
   * Type of storage system this connection uses.
   * Examples: 'SFTP', 'AZURE_BLOB', 'SHAREPOINT', 'LOCAL_FOLDER', 'AWS_S3'
   */
  storageType: string;

  /**
   * Environment where this connection points to.
   * Examples: 'DEV', 'UAT', 'PROD'
   * Used to manage separate connections for different environments.
   */
  environment: string;

  /**
   * The network endpoint (hostname, domain, or IP) of the source system.
   * Examples: 'sftp.example.com', 'myaccount.blob.core.windows.net', 'C:\files'
   */
  endpoint: string;

  /**
   * The port number for the connection.
   * Null if the storage type uses a default port or doesn't require a port.
   * Example: 22 for SFTP, 443 for HTTPS
   */
  port: number | null;

  /**
   * Username for authentication.
   * Null if the connection uses other authentication methods (e.g., managed identity, API key).
   * Note: The actual password is stored in a secrets vault, never in this config.
   */
  username: string | null;

  /**
   * Type of authentication used for this connection.
   * Examples: 'BASIC_AUTH', 'API_KEY', 'OAUTH2', 'MANAGED_IDENTITY', 'CERTIFICATE'
   */
  authenticationType: string;

  /**
   * Reference to the credential secret stored in a secrets vault.
   * Used by the secret-provider to retrieve actual credentials at runtime.
   * Never contains the actual secret value in the database.
   * Null if the authenticationType doesn't require a stored secret.
   * Example: 'sftp-prod-credentials' or 'vault://my-keyvault/sftp-password'
   */
  credentialRef: string | null;

  /**
   * Connection timeout in seconds.
   * Used to prevent hanging connections to unavailable systems.
   * Example: 30 means timeout after 30 seconds of no response.
   */
  timeoutSeconds: number;

  /**
   * Whether this connection is currently enabled.
   * If false, the Watcher will not attempt to use this connection.
   */
  enabledFlag: boolean;

  /**
   * Email or identifier of the person responsible for this connection.
   * Used in alert notifications and audit logs.
   * Null if no owner is configured.
   */
  owner: string | null;
}
