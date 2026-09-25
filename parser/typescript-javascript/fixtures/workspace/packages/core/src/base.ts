export class BaseClass {
  constructor(public value: string) {}

  greet(): string {
    return this.value;
  }
}
