#!/usr/bin/env bun
/**
 * Test publishWorktreeDone() API directly
 *
 * This demonstrates how a worktree agent would publish
 * completion notification using the TypeScript API.
 */

import { publishWorktreeDone } from './src/mqtt';

console.log('🧪 Testing publishWorktreeDone() API...\n');

// Test 1: Successful completion
console.log('Test 1: Successful completion (30s)');
publishWorktreeDone('feature-branch-1', 'done', 30, 'feature-agent');

// Test 2: Error
console.log('\nTest 2: Error (15s)');
publishWorktreeDone('bugfix-2', 'error', 15, 'bugfix-agent');

// Test 3: Cancelled
console.log('\nTest 3: Cancelled (5s)');
publishWorktreeDone('experiment-3', 'cancelled', 5, 'research-agent');

// Test 4: Long duration (125 seconds = 2m 5s)
console.log('\nTest 4: Long duration (125s = 2m 5s)');
publishWorktreeDone('data-analysis-4', 'done', 125, 'data-agent');

console.log('\n✅ All tests completed!');
console.log('\nCheck maw logs for notifications:');
console.log('  pm2 logs maw --lines 20');
