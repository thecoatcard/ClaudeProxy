/**
 * tests/intent-detector.test.ts
 *
 * Tests for the intent detector — ensures greetings, acknowledgments,
 * and trivial messages are correctly classified as TRIVIAL_CHAT.
 */

import { detectIntent, shouldSkipOrchestrator, extractUserMessage } from '@/lib/agent/intent-detector';

function makeBody(userMessage: string, system?: string) {
  return {
    ...(system ? { system } : {}),
    messages: [
      { role: 'user', content: userMessage },
    ],
  };
}

describe('IntentDetector', () => {
  describe('detectIntent', () => {
    test.each([
      'hi', 'Hello', 'hey', 'yo', 'sup', 'howdy',
      'Hi!', 'hello!', 'Hey.', 'hi?',
    ])('detects "%s" as TRIVIAL_CHAT', (msg) => {
      expect(detectIntent(makeBody(msg)).intent).toBe('TRIVIAL_CHAT');
    });

    test.each([
      'thanks', 'Thank you', 'thx', 'ty', 'cheers',
    ])('detects "%s" as TRIVIAL_CHAT', (msg) => {
      expect(detectIntent(makeBody(msg)).intent).toBe('TRIVIAL_CHAT');
    });

    test.each([
      'ok', 'okay', 'cool', 'nice', 'great', 'good', 'awesome',
      'perfect', 'sure', 'yep', 'yes', 'no', 'nope',
    ])('detects "%s" as TRIVIAL_CHAT', (msg) => {
      expect(detectIntent(makeBody(msg)).intent).toBe('TRIVIAL_CHAT');
    });

    test.each([
      'lol', 'haha', 'hmm', 'wow', 'oh',
    ])('detects "%s" as TRIVIAL_CHAT', (msg) => {
      expect(detectIntent(makeBody(msg)).intent).toBe('TRIVIAL_CHAT');
    });

    test('detects empty message as TRIVIAL_CHAT', () => {
      expect(detectIntent(makeBody('')).intent).toBe('TRIVIAL_CHAT');
    });

    test('detects single non-code words as TRIVIAL_CHAT', () => {
      expect(detectIntent(makeBody('continue')).intent).toBe('TRIVIAL_CHAT');
    });

    test('detects questions as QUESTION', () => {
      expect(detectIntent(makeBody('What is TypeScript?')).intent).toBe('QUESTION');
      expect(detectIntent(makeBody('How does Redis work?')).intent).toBe('QUESTION');
      expect(detectIntent(makeBody('Explain the retry logic')).intent).toBe('QUESTION');
    });

    test('detects tasks as TASK', () => {
      expect(detectIntent(makeBody('Fix the retry engine to handle 503 errors')).intent).toBe('TASK');
      expect(detectIntent(makeBody('Create a new component for the dashboard')).intent).toBe('TASK');
      expect(detectIntent(makeBody('Refactor the authentication module')).intent).toBe('TASK');
    });

    test('greeting with system prompt still classified as TRIVIAL_CHAT', () => {
      const body = makeBody('hi', 'You are a helpful coding assistant with access to many tools');
      expect(detectIntent(body).intent).toBe('TRIVIAL_CHAT');
    });

    test('does not classify code-like short messages as TRIVIAL_CHAT', () => {
      expect(detectIntent(makeBody('{}[]')).intent).not.toBe('TRIVIAL_CHAT');
    });
  });

  describe('shouldSkipOrchestrator', () => {
    test('skips orchestrator for greetings', () => {
      expect(shouldSkipOrchestrator(makeBody('hi'))).toBe(true);
      expect(shouldSkipOrchestrator(makeBody('hello'))).toBe(true);
    });

    test('skips orchestrator for questions', () => {
      expect(shouldSkipOrchestrator(makeBody('What is this?'))).toBe(true);
    });

    test('does not skip orchestrator for tasks', () => {
      expect(shouldSkipOrchestrator(makeBody('Build a REST API with authentication'))).toBe(false);
    });
  });

  describe('extractUserMessage', () => {
    test('extracts text from last user message only', () => {
      const body = {
        system: 'You are helpful',
        messages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'response' },
          { role: 'user', content: 'hi' },
        ],
      };
      expect(extractUserMessage(body)).toBe('hi');
    });

    test('extracts from content array', () => {
      const body = {
        messages: [
          { role: 'user', content: [{ text: 'hello' }] },
        ],
      };
      expect(extractUserMessage(body)).toBe('hello');
    });
  });
});
