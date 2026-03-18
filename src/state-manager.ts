import { mkdir, writeFile, readFile, readdir, unlink, stat } from "fs/promises";
import { join } from "path";
import { globalContextStore, type ContextEntry } from "./context-store";
import { globalLaneOrganization, type AgentHierarchy } from "./lane-organization";

// ============================================================================
// STATE SCHEMA
// ============================================================================

/**
 * Application state schema for persistence
 */
export interface MawState {
  version: number;
  exportedAt: number;

  // Context store
  contextEntries: ContextEntry[];

  // Lane organization
  agents: AgentHierarchy[];
  laneFilters: { [lane: string]: boolean };

  // Metadata
  metadata: {
    lastAgentUpdate: number;
    lastContextUpdate: number;
    totalSessions: number;
  };
}

// ============================================================================
// STATE MANAGER
// ============================================================================

const STATE_VERSION = 2;
const STATE_DIR = join(process.env.HOME || ".", ".maw");
const STATE_FILE = join(STATE_DIR, "state.json");

export class StateManager {
  private statePath: string;
  private autoSaveEnabled: boolean = true;
  private saveScheduled: boolean = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(statePath?: string) {
    this.statePath = statePath || STATE_FILE;
  }

  // ========================================================================
  // FILE I/O
  // ========================================================================

  /**
   * Ensure state directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await mkdir(STATE_DIR, { recursive: true });
    } catch (e: any) {
      if (e.code !== "EEXIST") {
        throw e;
      }
    }
  }

  /**
   * Save current state to file
   */
  async save(): Promise<void> {
    this.ensureDir();

    // Collect state from global stores
    const contextEntries = globalContextStore.getAllEntries();
    const agents = globalLaneOrganization.getAllAgents();
    const laneFilters = globalLaneOrganization.getLaneFilters();

    // Convert lane filters to object
    const laneFiltersObj: { [lane: string]: boolean } = {};
    laneFilters.forEach(f => {
      laneFiltersObj[f.lane] = f.enabled;
    });

    const state: MawState = {
      version: STATE_VERSION,
      exportedAt: Date.now(),
      contextEntries,
      agents,
      laneFilters: laneFiltersObj,
      metadata: {
        lastAgentUpdate: Date.now(),
        lastContextUpdate: Date.now(),
        totalSessions: 0, // TODO: get from session manager
      }
    };

    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * Load state from file
   */
  async load(): Promise<MawState | null> {
    this.ensureDir();

    try {
      const data = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(data) as MawState;

      // Migrate to current version if needed
      const migratedState = this.migrate(state);

      return migratedState;
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // No state file exists (fresh install)
        return null;
      }
      throw e;
    }
  }

  // ========================================================================
  // MIGRATION SYSTEM
  // ========================================================================

  /**
   * Migrate state from older version to current version
   */
  migrate(state: MawState): MawState {
    const currentVersion = STATE_VERSION;
    const stateVersion = state.version || 1;

    if (stateVersion === currentVersion) {
      return state; // Already at current version
    }

    console.log(`Migrating state from v${stateVersion} to v${currentVersion}`);

    // Version 1 → 2: Add metadata
    if (stateVersion === 1) {
      return {
        ...state,
        version: 2,
        metadata: {
          lastAgentUpdate: Date.now(),
          lastContextUpdate: Date.now(),
          totalSessions: 0
        }
      };
    }

    // Version 2 → Future: Add more fields
    // Example:
    // if (stateVersion === 2) {
    //   return {
    //     ...state,
    //     version: 3,
    //     newField: defaultValue
    //   };
    // }

    return state;
  }

  // ========================================================================
  // AUTO-SAVE
  // ========================================================================

  /**
   * Enable auto-save (default: enabled)
   */
  enableAutoSave(): void {
    this.autoSaveEnabled = true;
  }

  /**
   * Disable auto-save
   */
  disableAutoSave(): void {
    this.autoSaveEnabled = false;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  /**
   * Schedule auto-save (debounced)
   * Saves after 1 second of no changes
   */
  scheduleSave(): void {
    if (!this.autoSaveEnabled) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      try {
        await this.save();
        console.log("✓ State auto-saved");
      } catch (e: any) {
        console.error("✗ Auto-save failed:", e.message);
      }
    }, 1000);
  }

  // ========================================================================
  // STATE RESTORATION
  // ========================================================================

  /**
   * Restore state to global stores
   */
  async restore(): Promise<void> {
    const state = await this.load();

    if (!state) {
      console.log("No state file found (fresh install)");
      return;
    }

    console.log(`Restoring state from v${state.version}...`);

    // Clear existing state
    globalContextStore.clear();
    globalLaneOrganization.clear();

    // Restore context entries
    for (const entry of state.contextEntries) {
      globalContextStore.addEntry(entry);
    }
    console.log(`  → Restored ${state.contextEntries.length} context entries`);

    // Restore agents
    for (const agent of state.agents) {
      globalLaneOrganization.addAgent(agent);
    }
    console.log(`  → Restored ${state.agents.length} agents`);

    // Restore lane filters
    if (state.laneFilters) {
      Object.entries(state.laneFilters).forEach(([lane, enabled]) => {
        globalLaneOrganization.setLaneFilter(lane as any, enabled as boolean);
      });
    }
    console.log(`  → Restored lane filters`);

    console.log("✓ State restored successfully");
  }

  // ========================================================================
  // BACKUP MANAGEMENT
  // ========================================================================

  /**
   * Create backup before major changes
   */
  async createBackup(): Promise<string> {
    this.ensureDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = join(STATE_DIR, `state-backup-${timestamp}.json`);

    const data = await readFile(this.statePath, "utf-8");
    await writeFile(backupFile, data, "utf-8");

    console.log(`✓ Backup created: ${backupFile}`);
    return backupFile;
  }

  /**
   * List all backups
   */
  async listBackups(): Promise<string[]> {
    this.ensureDir();

    try {
      const files = await readdir(STATE_DIR);
      return files
        .filter(f => f.startsWith("state-backup-") && f.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupFile: string): Promise<void> {
    const backupPath = join(STATE_DIR, backupFile);
    const data = await readFile(backupPath, "utf-8");
    const state = JSON.parse(data) as MawState;

    // Save backup as current state
    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");

    // Restore
    await this.restore();

    console.log(`✓ Restored from backup: ${backupFile}`);
  }

  /**
   * Clean up old backups (keep last 10)
   */
  async cleanupBackups(keepCount: number = 10): Promise<void> {
    const backups = await this.listBackups();

    if (backups.length <= keepCount) {
      return;
    }

    const toDelete = backups.slice(keepCount);

    for (const backup of toDelete) {
      const backupPath = join(STATE_DIR, backup);
      await unlink(backupPath);
    }

    console.log(`✓ Cleaned up ${toDelete.length} old backups`);
  }

  // ========================================================================
  // STATE INFO
  // ========================================================================

  /**
   * Get state file information
   */
  async getStateInfo(): Promise<{
    exists: boolean;
    size: number;
    modified: number;
    version: number;
  } | null> {
    try {
      const statResult = await stat(this.statePath);
      const data = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(data);

      return {
        exists: true,
        size: statResult.size,
        modified: statResult.mtimeMs,
        version: state.version
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// GLOBAL SINGLETON
// ============================================================================

export const globalStateManager = new StateManager();

// ============================================================================
// HOOKS FOR AUTO-SAVE
// ============================================================================

/**
 * Initialize state manager with auto-save on store changes
 */
export function initializeStateManager(stateManager: StateManager): void {
  // Hook into context store (add entry)
  const originalAddEntry = globalContextStore.addEntry.bind(globalContextStore);
  globalContextStore.addEntry = function(entry: ContextEntry): void {
    originalAddEntry(entry);
    stateManager.scheduleSave();
  };

  // Hook into lane organization (add/update agent)
  const originalAddAgent = globalLaneOrganization.addAgent.bind(globalLaneOrganization);
  globalLaneOrganization.addAgent = function(agent: AgentHierarchy): void {
    originalAddAgent(agent);
    stateManager.scheduleSave();
  };

  // Hook into lane organization (toggle filter)
  const originalToggleLane = globalLaneOrganization.toggleLaneFilter.bind(globalLaneOrganization);
  globalLaneOrganization.toggleLaneFilter = function(lane: string): boolean {
    const result = originalToggleLane(lane);
    stateManager.scheduleSave();
    return result;
  };

  console.log("✓ State manager initialized with auto-save hooks");
}
