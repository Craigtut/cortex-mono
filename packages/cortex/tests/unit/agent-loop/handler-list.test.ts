import { describe, it, expect, vi } from 'vitest';
import { HandlerList } from '../../../src/agent-loop/handler-list.js';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('HandlerList', () => {
  it('isolates a throwing handler and logs it with the label and described fields', () => {
    const log = logger();
    const list = new HandlerList<[taskId: string, detail: string]>('onThing', log, (taskId) => ({ taskId }));
    const after = vi.fn();
    list.add(() => {
      throw new Error('boom');
    });
    list.add(after);

    list.emit('t1', 'x');

    expect(after).toHaveBeenCalledWith('t1', 'x');
    expect(log.error).toHaveBeenCalledWith('onThing handler threw', { taskId: 't1', error: 'boom' });
  });

  it('clears registrations', () => {
    const list = new HandlerList<[]>('onThing', logger());
    const handler = vi.fn();
    list.add(handler);
    expect(list.size).toBe(1);
    list.clear();
    list.emit();
    expect(handler).not.toHaveBeenCalled();
    expect(list.size).toBe(0);
  });
});
