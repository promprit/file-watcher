exports.up = (pgm) => {
  pgm.createTable({ schema: 'watcher_schema', name: 'connection_config' }, {
    connection_ref: { type: 'varchar(100)', primaryKey: true },
    storage_type: { type: 'varchar(50)', notNull: true },
    environment: { type: 'varchar(50)', notNull: true },
    endpoint: { type: 'varchar(500)', notNull: true },
    port: { type: 'integer' },
    username: { type: 'varchar(255)' },
    authentication_type: { type: 'varchar(50)', notNull: true },
    credential_ref: { type: 'varchar(255)' },
    timeout_seconds: { type: 'integer', notNull: true, default: 30 },
    enabled_flag: { type: 'boolean', notNull: true, default: true },
    owner: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'connection_config' }, 'storage_type', {
    name: 'idx_connection_config_storage_type',
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'connection_config' }, 'enabled_flag', {
    name: 'idx_connection_config_enabled',
    where: 'enabled_flag = true',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'watcher_schema', name: 'connection_config' }, {
    ifExists: true,
  });
};
