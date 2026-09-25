const { run } = require('@fixture/core');

export function legacy(value) {
  return run(value);
}

module.exports = { legacy };
