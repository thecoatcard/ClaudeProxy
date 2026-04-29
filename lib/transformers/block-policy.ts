import { nanoid } from 'nanoid';

export interface BlockState {
  type: 'text' | 'thinking' | 'tool_use';
  downIndex: number;
  open: boolean;
  id?: string; // For tool_use
  name?: string; // For tool_use
}

/**
 * Manages the state of content blocks in an Anthropic-compatible stream.
 * Ensures that blocks are opened and closed correctly, even if the upstream
 * model (Gemini) switches between types or sends interleaved data.
 */
export class BlockPolicy {
  private nextIndex: number = 0;
  private byUpstream: Map<number, BlockState> = new Map();
  private currentOpenUpstream: number | null = null;

  constructor() {}

  /**
   * Generates necessary content_block_stop events to close any currently open block
   * that is NOT the one we are about to work on.
   */
  public ensureOnlyBlock(upstreamIndex: number): string[] {
    const events: string[] = [];
    
    if (this.currentOpenUpstream !== null && this.currentOpenUpstream !== upstreamIndex) {
      const state = this.byUpstream.get(this.currentOpenUpstream);
      if (state && state.open) {
        events.push(this.formatEvent('content_block_stop', {
          type: 'content_block_stop',
          index: state.downIndex
        }));
        state.open = false;
      }
    }
    
    this.currentOpenUpstream = upstreamIndex;
    return events;
  }

  /**
   * Opens a new block if it doesn't exist, or returns the existing one.
   * Returns [events_to_emit, down_index]
   */
  public getOrStartBlock(upstreamIndex: number, type: 'text' | 'thinking' | 'tool_use', metadata?: any): [string[], number] {
    const events: string[] = [];
    let state = this.byUpstream.get(upstreamIndex);

    if (!state || !state.open || state.type !== type) {
      // Close previous if needed
      events.push(...this.ensureOnlyBlock(upstreamIndex));

      const newIndex = this.nextIndex++;
      state = {
        type,
        downIndex: newIndex,
        open: true,
        ...metadata
      };
      
      if (type === 'tool_use' && !state.id) {
        state.id = 'toolu_' + nanoid(24);
      }

      this.byUpstream.set(upstreamIndex, state);

      const contentBlock: any = { type };
      if (type === 'text') contentBlock.text = '';
      if (type === 'thinking') contentBlock.thinking = '';
      if (type === 'tool_use') {
        contentBlock.id = state.id;
        contentBlock.name = state.name || '';
        contentBlock.input = {};
      }

      events.push(this.formatEvent('content_block_start', {
        type: 'content_block_start',
        index: newIndex,
        content_block: contentBlock
      }));
    }

    return [events, state.downIndex];
  }

  public closeAll(): string[] {
    const events: string[] = [];
    for (const [idx, state] of this.byUpstream.entries()) {
      if (state.open) {
        events.push(this.formatEvent('content_block_stop', {
          type: 'content_block_stop',
          index: state.downIndex
        }));
        state.open = false;
      }
    }
    this.currentOpenUpstream = null;
    return events;
  }

  public getToolId(upstreamIndex: number): string | undefined {
    return this.byUpstream.get(upstreamIndex)?.id;
  }

  private formatEvent(event: string, data: any): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
