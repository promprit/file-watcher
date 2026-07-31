exports.up = (pgm) => {
  pgm.createTable({ schema: 'watcher_schema', name: 'interface_config' }, {
    interface_id: { type: 'varchar(50)', primaryKey: true },
    interface_name: { type: 'varchar(255)', notNull: true },
    source_system: { type: 'varchar(100)', notNull: true },
    target_system: { type: 'varchar(100)', notNull: true },
    connection_ref: { type: 'varchar(100)', notNull: true },
    inbound_path: { type: 'text', notNull: true },
    file_pattern: { type: 'varchar(255)', notNull: true },
    poll_interval_seconds: { type: 'integer', notNull: true, default: 60 },
    readiness_rule: { type: 'varchar(50)', notNull: true, default: "'STABLE_SIZE'" },
    stability_check_seconds: { type: 'integer', notNull: true, default: 30 },
    duplicate_check_enabled: { type: 'boolean', notNull: true, default: true },
    stuck_threshold_minutes: { type: 'integer' },
    expected_schedule: { type: 'varchar(100)' },
    sla_threshold_minutes: { type: 'integer' },
    alert_owner: { type: 'varchar(255)' },
    enabled_flag: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'interface_config' }, 'connection_ref', {
    name: 'idx_interface_config_connection_ref',
  });

  pgm.createIndex({ schema: 'watcher_schema', name: 'interface_config' }, 'enabled_flag', {
    name: 'idx_interface_config_enabled',
    where: 'enabled_flag = true',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'watcher_schema', name: 'interface_config' }, {
    ifExists: true,
  });
};
