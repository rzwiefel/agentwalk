export interface SharedThing {
  id: string;
}

export type SharedAlias = SharedThing & { label?: string };
