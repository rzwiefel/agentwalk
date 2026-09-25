import { Derived } from '@fixture/core';
import type { SharedAlias } from '@shared/types.js';

const item: SharedAlias = { id: 'demo' };

export function render(value: string): JSX.Element {
  return (
    <section>
      <Derived value={value} />
      <button>{item.id}</button>
    </section>
  );
}
