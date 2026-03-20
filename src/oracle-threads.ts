/**
 * Oracle Threads Integration
 *
 * Provides MCP-based integration with Oracle Threads system for:
 * - Creating consultation threads
 * - Reading thread content
 * - Managing thread lifecycle
 *
 * Threads created via MQTT consultations are tracked for later
 * sync to Memory Hub.
 */

import { getNotificationSystem } from './notification-system';

export interface OracleThread {
  id: number;
  title: string;
  message?: string;
  metadata?: {
    agent?: string;
    target?: string;
    source?: 'mqtt' | 'web' | 'api';
    created_at?: string;
    synced_to_memory?: boolean;
  };
}

/**
 * Create an Oracle Thread via MCP
 *
 * @param title Thread title (consultation topic)
 * @param message Initial message content
 * @param metadata Optional metadata (agent, target, source)
 * @returns Thread object with ID
 */
export async function createOracleThread(
  title: string,
  message?: string,
  metadata?: Partial<OracleThread['metadata']>
): Promise<OracleThread> {
  try {
    // TODO: Replace with actual MCP call when available
    // For now, we'll create a mock thread and log it
    const threadId = Math.floor(Math.random() * 10000) + 1000; // Mock ID

    const thread: OracleThread = {
      id: threadId,
      title: title.slice(0, 200), // Limit title length
      message: message?.slice(0, 5000), // Limit message length
      metadata: {
        ...metadata,
        source: metadata?.source || 'mqtt',
        created_at: new Date().toISOString(),
        synced_to_memory: false,
      }
    };

    console.log(`🧵 Oracle Thread created: #${threadId}`);
    console.log(`   Title: ${thread.title.slice(0, 80)}...`);

    // Add notification
    const notifications = getNotificationSystem();
    notifications.add({
      channel: 'threads',
      type: 'thread_created',
      title: '💬 Thread Created',
      message: `#${threadId}: ${thread.title.slice(0, 60)}...`,
      metadata: {
        thread_id: threadId,
        agent: metadata?.agent,
        target: metadata?.target,
      }
    });

    return thread;
  } catch (e) {
    console.error('❌ Oracle Threads: error creating thread:', e);
    throw e;
  }
}

/**
 * Read an Oracle Thread via MCP
 *
 * @param threadId Thread ID
 * @returns Thread content with messages
 */
export async function readOracleThread(threadId: number): Promise<{
  thread: OracleThread;
  messages: Array<{
    id: string;
    role: 'human' | 'assistant';
    content: string;
    timestamp: string;
  }>;
} | null> {
  try {
    // TODO: Replace with actual MCP call when available
    console.log(`🧵 Reading Oracle Thread #${threadId}...`);

    // Mock response for now
    return {
      thread: {
        id: threadId,
        title: 'Mock Thread Title',
        metadata: {
          source: 'mqtt',
          created_at: new Date().toISOString(),
          synced_to_memory: false,
        }
      },
      messages: []
    };
  } catch (e) {
    console.error(`❌ Oracle Threads: error reading thread #${threadId}:`, e);
    return null;
  }
}

/**
 * List Oracle Threads (optionally filtered by agent/target)
 *
 * @param filters Optional filters
 * @returns Array of threads
 */
export async function listOracleThreads(filters?: {
  agent?: string;
  target?: string;
  source?: string;
  unsynced_only?: boolean;
}): Promise<OracleThread[]> {
  try {
    // TODO: Replace with actual MCP call when available
    console.log('🧵 Listing Oracle Threads...', filters);

    // Mock response for now
    return [];
  } catch (e) {
    console.error('❌ Oracle Threads: error listing threads:', e);
    return [];
  }
}

/**
 * Mark thread as synced to Memory Hub
 *
 * @param threadId Thread ID
 */
export async function markThreadSynced(threadId: number): Promise<void> {
  try {
    // TODO: Replace with actual MCP call when available
    console.log(`🧵 Marked thread #${threadId} as synced to Memory Hub`);
  } catch (e) {
    console.error(`❌ Oracle Threads: error marking thread #${threadId} as synced:`, e);
  }
}

/**
 * Classify thread content for Memory Hub routing
 *
 * Determines which Memory Hub category the thread belongs to:
 * - retrospective: Session summaries, lessons learned
 * - learning: Patterns, best practices, technical insights
 * - resonance: Philosophical discussions, Oracle principles
 *
 * @param title Thread title
 * @param messages Thread messages
 * @returns Memory Hub category
 */
export function classifyThreadForMemoryHub(
  title: string,
  messages: Array<{ role: string; content: string }>
): 'retrospective' | 'learning' | 'resonance' {
  const text = `${title} ${messages.map(m => m.content).join(' ')}`.toLowerCase();

  // Check for retrospective patterns
  const retrospectivePatterns = [
    'session', 'retrospective', 'what did we', 'summary of work',
    'lessons learned', 'what went wrong', 'what went well',
    'completed task', 'finished work', 'day review',
  ];

  // Check for learning patterns
  const learningPatterns = [
    'how to', 'pattern', 'best practice', 'implementation',
    'technical', 'architecture', 'code example', 'solution',
    'fix', 'debug', 'optimize', 'refactor',
  ];

  // Check for resonance patterns
  const resonancePatterns = [
    'principle', 'philosophy', 'oracle', 'consciousness',
    'meaning', 'purpose', 'existence', 'approach',
    'thinking', 'mindset', 'framework', 'guidance',
  ];

  // Score each category
  const retrospectiveScore = retrospectivePatterns.filter(p => text.includes(p)).length;
  const learningScore = learningPatterns.filter(p => text.includes(p)).length;
  const resonanceScore = resonancePatterns.filter(p => text.includes(p)).length;

  // Return highest scoring category
  if (retrospectiveScore >= learningScore && retrospectiveScore >= resonanceScore) {
    return 'retrospective';
  } else if (learningScore >= resonanceScore) {
    return 'learning';
  } else {
    return 'resonance';
  }
}
