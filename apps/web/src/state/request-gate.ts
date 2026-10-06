export interface RequestIdentity { sessionId: string; generation: number; queryKey: string; requestId: string }
export interface QueryTicket extends RequestIdentity { slot: string; controller: AbortController }

/** Cancellation saves work; this identity gate is what prevents stale UI writes. */
export class RequestGate {
  private context = { sessionId: 'startup', generation: 0 };
  private active = new Map<string, QueryTicket>();
  setContext(sessionId: string, generation: number): void {
    this.cancelAll();
    this.context = { sessionId, generation };
  }
  begin(slot: string, queryKey: string): QueryTicket {
    this.cancel(slot);
    const ticket = { ...this.context, slot, queryKey, requestId: crypto.randomUUID(), controller: new AbortController() };
    this.active.set(slot, ticket);
    return ticket;
  }
  accepts(ticket: QueryTicket, response?: RequestIdentity): boolean {
    const current = this.active.get(ticket.slot);
    return !ticket.controller.signal.aborted && current?.requestId === ticket.requestId &&
      this.context.sessionId === ticket.sessionId && this.context.generation === ticket.generation &&
      current.queryKey === ticket.queryKey && (!response || (response.sessionId === ticket.sessionId &&
        response.generation === ticket.generation && response.queryKey === ticket.queryKey && response.requestId === ticket.requestId));
  }
  cancel(slot: string): void { this.active.get(slot)?.controller.abort(); this.active.delete(slot); }
  cancelAll(): void { for (const ticket of this.active.values()) ticket.controller.abort(); this.active.clear(); }
}
