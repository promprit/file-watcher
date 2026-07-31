exports.up = (pgm) => {
  pgm.createTable({ schema: 'watcher_schema', name: 'watcher_state' }, {
    state_id: { type: 'bigserial', primaryKey: true },
    interface_id: { type: 'varchar(50)', notNull: true },
    batch_id: { type: 'varchar(100)', notNull: true, unique: true },
    file_path: { type: 'text', notNull: true },
    file_name: { type: 'varchar(500)', notNull: true },
    file_size_bytes: { type: 'bigint', notNull: true },
    previous_status: { type: 'varchar(50)' },
    current_status: { type: 'varchar(50)', notNull: true },
    status_changed_at: { type: 'timestamptz', notNull: true },
    first_detected_at: { type: 'timestamptz', notNull: true },
    last_seen_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint({ schema: 'watcher_schema', name: 'watcher_state' }, 'unique_interface_file', {
    unique: ['interface_id', 'file_path'],
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'watcher_state' }, 'interface_id', {
    name: 'idx_watcher_state_interface',
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'watcher_state' }, 'current_status', {
    name: 'idx_watcher_state_status',
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'watcher_state' }, 'batch_id', {
    name: 'idx_watcher_state_batch',
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'watcher_state' }, 'status_changed_at', {
    name: 'idx_watcher_state_status_changed',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'watcher_schema', name: 'watcher_state' }, {
    ifExists: true,
  });
};
