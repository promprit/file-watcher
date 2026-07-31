exports.up = (pgm) => {
  pgm.createSchema('watcher_schema', {
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropSchema('watcher_schema', {
    ifExists: true,
    cascade: true,
  });
};
