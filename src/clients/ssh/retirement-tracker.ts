import type { SshChildRetirement } from './child-lifecycle';

export class SshRetirementTracker {
  private readonly children = new Set<SshChildRetirement>();
  private readonly tasks = new Set<Promise<void>>();

  adopt(retirement: SshChildRetirement): void {
    this.children.add(retirement);
  }

  track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  async retire(retirement: SshChildRetirement): Promise<void> {
    await retirement.retire();
    this.children.delete(retirement);
  }

  async retireAll(): Promise<unknown[]> {
    const childResults = await Promise.allSettled(
      [...this.children].map((retirement) => this.retire(retirement)),
    );
    await Promise.allSettled([...this.tasks]);
    return childResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
  }
}
