import type { SharedThing } from '@shared/types.js';
import { sharedFn as helper } from '@shared/util.js';
import BaseFormatter from './default.js';
import { BaseClass } from './base.js';

export interface CoreThing extends SharedThing {
  label: string;
}

export class Derived extends BaseClass implements SharedThing {
  override greet(): string {
    return helper(super.greet());
  }
}

export function run(value: string): string {
  const item = new Derived(value);
  item.greet();
  return BaseFormatter(value);
}

export { helper as reExported };
export type { SharedThing };
