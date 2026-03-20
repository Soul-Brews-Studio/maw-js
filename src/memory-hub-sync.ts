/**
 * Memory Hub Sync Service
 *
 * Automatically sync Oracle Thread conversations to Memory Hub
 * - ψ/memory/retrospectives/ - Session logs
 * - ψ/memory/learnings/ - Reusable patterns
 * - ψ/memory/resonance/ - Core principles
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { listOracleThreads, readOracleThread, markThreadSynced, classifyThreadForMemoryHub } from './oracle-threads';
import { getNotificationSystem } from './notification-system';

interface ThreadMessage {
  id: string;
  role: 'human' | 'assistant';
  content: string;
  timestamp: string;
}

interface Thread {
  id: string;
  title: string;
  participants: string[];
  messages: ThreadMessage[];
  created_at: string;
  updated_at: string;
}

interface SyncConfig {
  projectRoot: string;
  autoClassify: boolean;
  enableRealtime: boolean;
}

export class MemoryHubSync {
  private config: SyncConfig;
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SyncConfig) {
    this.config = config;
  }

  /**
   * Start automatic sync from Oracle Threads to Memory Hub
   */
  start() {
    if (this.syncInterval) {
      console.warn('⚠️ Memory Hub Sync: already running');
      return;
    }

    console.log('🧠 Memory Hub Sync: starting...');
    console.log(`   Project root: ${this.config.projectRoot}`);
    console.log(`   Auto-classify: ${this.config.autoClassify}`);
    console.log(`   Real-time: ${this.config.enableRealtime}`);

    // Poll every 30 seconds for new threads
    this.syncInterval = setInterval(async () => {
      await this.syncThreads();
    }, 30000);

    // Initial sync
    this.syncThreads();
  }

  /**
   * Stop sync service
   */
  stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('👋 Memory Hub Sync: stopped');
    }
  }

  /**
   * Sync Oracle Threads to Memory Hub
   */
  private async syncThreads() {
    try {
      console.log('🔄 Memory Hub Sync: checking for new threads...');

      // Get list of unsynced threads
      const threads = await listOracleThreads({ unsynced_only: true });

      if (threads.length === 0) {
        console.log('📋 Memory Hub Sync: no new threads to sync');
        return;
      }

      console.log(`📋 Memory Hub Sync: found ${threads.length} threads to sync`);

      // Limit threads per sync to avoid overwhelming the system
      const threadsToSync = threads.slice(0, 10);

      for (const thread of threadsToSync) {
        try {
          // Read thread content
          const threadData = await readOracleThread(thread.id);

          if (!threadData) {
            console.warn(`⚠️  Thread #${thread.id}: could not read content`);
            continue;
          }

          // Classify thread
          const category = classifyThreadForMemoryHub(threadData.thread.title, threadData.messages);

          console.log(`🧠 Thread #${thread.id}: ${category} - "${threadData.thread.title.slice(0, 60)}..."`);

          // Write to Memory Hub
          await this.writeToMemoryHubFromThread(threadData, category);

          // Mark as synced
          await markThreadSynced(thread.id);

          // Add notification
          const notifications = getNotificationSystem();
          notifications.add({
            channel: 'memory',
            type: 'thread_synced',
            title: '🧠 Thread Synced',
            message: `#${thread.id}: ${threadData.thread.title.slice(0, 60)}...`,
            metadata: {
              thread_id: thread.id,
              category,
            }
          });

          console.log(`✅ Thread #${thread.id}: synced to Memory Hub`);

        } catch (e) {
          console.error(`❌ Thread #${thread.id}: sync failed`, e);
        }
      }

    } catch (e) {
      console.error('❌ Memory Hub Sync: error', e);
    }
  }

  /**
   * Classify thread content type
   */
  private classifyThread(thread: Thread): 'retrospective' | 'learning' | 'resonance' {
    const content = thread.messages.map(m => m.content).join(' ').toLowerCase();

    // Retrospective: session summary, what happened
    if (content.includes('session') ||
        content.includes('retrospective') ||
        content.includes('what we did') ||
        content.includes('summary')) {
      return 'retrospective';
    }

    // Learning: patterns, lessons, how-to
    if (content.includes('learned') ||
        content.includes('pattern') ||
        content.includes('lesson') ||
        content.includes('how to') ||
        content.includes('best practice')) {
      return 'learning';
    }

    // Resonance: principles, philosophy, core insights
    if (content.includes('principle') ||
        content.includes('philosophy') ||
        content.includes('core') ||
        content.includes('fundamental')) {
      return 'resonance';
    }

    // Default: retrospective
    return 'retrospective';
  }

  /**
   * Format thread as markdown
   */
  private formatThreadAsMarkdown(thread: Thread, type: string): string {
    const date = new Date(thread.created_at).toISOString().split('T')[0];

    let markdown = `# ${thread.title}\n\n`;
    markdown += `**Date**: ${date}\n`;
    markdown += `**Thread ID**: ${thread.id}\n`;
    markdown += `**Participants**: ${thread.participants.join(', ')}\n`;
    markdown += `**Type**: ${type}\n\n`;
    markdown += `---\n\n`;

    // Messages
    for (const message of thread.messages) {
      const role = message.role === 'human' ? '👤 User' : '🤖 Assistant';
      const time = new Date(message.timestamp).toLocaleTimeString();
      markdown += `### ${role} (${time})\n\n`;
      markdown += `${message.content}\n\n`;
    }

    return markdown;
  }

  /**
   * Format thread data from Oracle Threads as markdown
   */
  private formatOracleThreadAsMarkdown(
    threadData: { thread: { id: number; title: string; metadata?: any }; messages: Array<{ role: string; content: string }> },
    type: string
  ): string {
    const { thread, messages } = threadData;
    const date = new Date(thread.metadata?.created_at || Date.now()).toISOString().split('T')[0];

    let markdown = `# ${thread.title}\n\n`;
    markdown += `**Date**: ${date}\n`;
    markdown += `**Thread ID**: #${thread.id}\n`;
    markdown += `**Type**: ${type}\n`;
    markdown += `**Source**: ${thread.metadata?.source || 'unknown'}\n`;
    markdown += `**Agent**: ${thread.metadata?.agent || 'unknown'}\n`;
    markdown += `**Target**: ${thread.metadata?.target || 'unknown'}\n\n`;
    markdown += `---\n\n`;

    // Messages
    if (messages.length > 0) {
      for (const message of messages) {
        const role = message.role === 'human' ? '👤 Human' : '🤖 Oracle';
        markdown += `### ${role}\n\n`;
        markdown += `${message.content}\n\n`;
      }
    } else {
      markdown += `*No messages in thread*\n\n`;
    }

    markdown += `---\n\n`;
    markdown += `*Auto-synced from Oracle Thread #${thread.id}*\n`;

    return markdown;
  }

  /**
   * Write Oracle Thread to Memory Hub
   */
  private async writeToMemoryHubFromThread(
    threadData: { thread: { id: number; title: string; metadata?: any }; messages: Array<{ role: string; content: string }> },
    type: 'retrospective' | 'learning' | 'resonance'
  ) {
    const { projectRoot } = this.config;

    // Determine directory and filename
    let dir: string;
    let filename: string;
    const date = threadData.thread.metadata?.created_at || new Date().toISOString();
    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];

    if (type === 'retrospective') {
      const yearMonth = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
      dir = join(projectRoot, 'ψ/memory/retrospectives', yearMonth);
      filename = `thread-${dateStr}-${threadData.thread.id}.md`;
    } else if (type === 'learning') {
      dir = join(projectRoot, 'ψ/memory/learnings');
      filename = `thread-${dateStr}-${threadData.thread.id}.md`;
    } else {
      dir = join(projectRoot, 'ψ/memory/resonance');
      filename = `thread-${dateStr}-${threadData.thread.id}.md`;
    }

    // Create directory if not exists
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Format and write
    const markdown = this.formatOracleThreadAsMarkdown(threadData, type);
    const filepath = join(dir, filename);

    await writeFile(filepath, markdown, 'utf-8');

    console.log(`✅ Memory Hub: saved ${type} to ${filepath}`);
  }

  /**
   * Write thread to Memory Hub (from Thread interface)
   */
  private async writeToMemoryHub(thread: Thread, type: 'retrospective' | 'learning' | 'resonance') {
    const { projectRoot } = this.config;

    // Determine directory
    let dir: string;
    let filename: string;

    if (type === 'retrospective') {
      const date = new Date(thread.created_at);
      const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      dir = join(projectRoot, 'ψ/memory/retrospectives', yearMonth);
      filename = `${date.toISOString().split('T')[0]}_thread-${thread.id.slice(0, 8)}.md`;
    } else if (type === 'learning') {
      dir = join(projectRoot, 'ψ/memory/learnings');
      filename = `${new Date(thread.created_at).toISOString().split('T')[0]}_${thread.title.slice(0, 30).replace(/\s+/g, '-')}.md`;
    } else {
      dir = join(projectRoot, 'ψ/memory/resonance');
      filename = `${thread.title.slice(0, 30).replace(/\s+/g, '-')}.md`;
    }

    // Create directory if not exists
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Format and write
    const markdown = this.formatThreadAsMarkdown(thread, type);
    const filepath = join(dir, filename);

    await writeFile(filepath, markdown, 'utf-8');

    console.log(`✅ Memory Hub: saved ${type} to ${filepath}`);
  }

  /**
   * Manual sync: import a thread directly
   */
  async importThread(thread: Thread) {
    if (!this.config.autoClassify) {
      console.warn('⚠️ Auto-classify disabled, skipping thread import');
      return;
    }

    const type = this.classifyThread(thread);
    await this.writeToMemoryHub(thread, type);

    return type;
  }
}

/**
 * Singleton instance
 */
let memoryHubSync: MemoryHubSync | null = null;

export function startMemoryHubSync(config: SyncConfig) {
  if (memoryHubSync) {
    console.warn('⚠️ Memory Hub Sync already initialized');
    return memoryHubSync;
  }

  memoryHubSync = new MemoryHubSync(config);
  memoryHubSync.start();
  return memoryHubSync;
}

export function stopMemoryHubSync() {
  if (memoryHubSync) {
    memoryHubSync.stop();
    memoryHubSync = null;
  }
}

export function getMemoryHubSync(): MemoryHubSync | null {
  return memoryHubSync;
}
