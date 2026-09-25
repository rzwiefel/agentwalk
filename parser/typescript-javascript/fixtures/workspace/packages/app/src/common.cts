const missing = require('./missing-module');

export function common(value: string) {
  notDefined(value);
  return missing(value);
}
