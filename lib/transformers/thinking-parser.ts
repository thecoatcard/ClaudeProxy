export enum ContentType {
  TEXT = 'text',
  THINKING = 'thinking'
}

export interface ContentChunk {
  type: ContentType;
  content: string;
}

/**
 * Stateful streaming parser for <think>...</think> or <thought>...</thought> tags.
 * Handles partial tags at chunk boundaries.
 */
export class ThinkTagParser {
  private buffer: string = '';
  private inThinkTag: boolean = false;
  
  private static OPEN_TAGS = ['<think>', '<thought>'];
  private static CLOSE_TAGS = ['</think>', '</thought>'];

  constructor() {}

  public get isInThinkMode(): boolean {
    return this.inThinkTag;
  }

  /**
   * Feed content and return parsed chunks.
   */
  public *feed(content: string): IterableIterator<ContentChunk> {
    this.buffer += content;

    while (this.buffer) {
      const prevLen = this.buffer.length;
      let chunk: ContentChunk | null = null;

      if (!this.inThinkTag) {
        chunk = this.parseOutside();
      } else {
        chunk = this.parseInside();
      }

      if (chunk) {
        yield chunk;
      } else if (this.buffer.length === prevLen) {
        // No progress (likely waiting for more content to complete a tag)
        break;
      }
    }
  }

  private parseOutside(): ContentChunk | null {
    let earliestStart = -1;
    let selectedOpenTag = '';

    for (const tag of ThinkTagParser.OPEN_TAGS) {
      const idx = this.buffer.indexOf(tag);
      if (idx !== -1 && (earliestStart === -1 || idx < earliestStart)) {
        earliestStart = idx;
        selectedOpenTag = tag;
      }
    }

    if (earliestStart === -1) {
      // Check for partial tags at the end of the buffer
      const lastBracket = this.buffer.lastIndexOf('<');
      if (lastBracket !== -1) {
        const potential = this.buffer.slice(lastBracket);
        const isPotential = ThinkTagParser.OPEN_TAGS.some(t => t.startsWith(potential)) ||
                           ThinkTagParser.CLOSE_TAGS.some(t => t.startsWith(potential));
        
        if (isPotential) {
          const emit = this.buffer.slice(0, lastBracket);
          this.buffer = this.buffer.slice(lastBracket);
          return emit ? { type: ContentType.TEXT, content: emit } : null;
        }
      }

      const emit = this.buffer;
      this.buffer = '';
      return emit ? { type: ContentType.TEXT, content: emit } : null;
    }

    const preThink = this.buffer.slice(0, earliestStart);
    this.buffer = this.buffer.slice(earliestStart + selectedOpenTag.length);
    this.inThinkTag = true;
    return preThink ? { type: ContentType.TEXT, content: preThink } : null;
  }

  private parseInside(): ContentChunk | null {
    let earliestEnd = -1;
    let selectedCloseTag = '';

    for (const tag of ThinkTagParser.CLOSE_TAGS) {
      const idx = this.buffer.indexOf(tag);
      if (idx !== -1 && (earliestEnd === -1 || idx < earliestEnd)) {
        earliestEnd = idx;
        selectedCloseTag = tag;
      }
    }

    if (earliestEnd === -1) {
      // Check for partial close tag
      const lastBracket = this.buffer.lastIndexOf('<');
      if (lastBracket !== -1 && this.buffer.length - lastBracket < 10) {
        const potential = this.buffer.slice(lastBracket);
        if (ThinkTagParser.CLOSE_TAGS.some(t => t.startsWith(potential))) {
          const emit = this.buffer.slice(0, lastBracket);
          this.buffer = this.buffer.slice(lastBracket);
          return emit ? { type: ContentType.THINKING, content: emit } : null;
        }
      }

      const emit = this.buffer;
      this.buffer = '';
      return emit ? { type: ContentType.THINKING, content: emit } : null;
    }

    const thinkingContent = this.buffer.slice(0, earliestEnd);
    this.buffer = this.buffer.slice(earliestEnd + selectedCloseTag.length);
    this.inThinkTag = false;
    return thinkingContent ? { type: ContentType.THINKING, content: thinkingContent } : null;
  }

  public flush(): ContentChunk | null {
    if (this.buffer) {
      const chunk = {
        type: this.inThinkTag ? ContentType.THINKING : ContentType.TEXT,
        content: this.buffer
      };
      this.buffer = '';
      return chunk;
    }
    return null;
  }
}
