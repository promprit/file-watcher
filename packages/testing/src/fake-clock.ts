export class FakeClock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  setNow(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
