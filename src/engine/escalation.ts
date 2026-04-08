/**
 * Health Escalation Chain — multi-level alert system.
 *
 * L1: Discord webhook (immediate)
 * L2: LINE Notify (after 5 minutes if unacknowledged)
 * L3: Repeat all channels (every 10 minutes)
 */

import { sendLineNotify } from "./line-notify";

export interface EscalationLevel {
  channel: "discord" | "line" | "repeat";
  delaySeconds: number;
}

interface ActiveAlert {
  id: string;
  reason: string;
  metrics: any;
  level: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_LEVELS: EscalationLevel[] = [
  { channel: "discord", delaySeconds: 0 },
  { channel: "line", delaySeconds: 300 },
  { channel: "repeat", delaySeconds: 600 },
];

export class EscalationChain {
  private levels: EscalationLevel[];
  private active = new Map<string, ActiveAlert>();
  private discordFn: ((metrics: any, reason: string) => Promise<void>) | null = null;
  private lineToken: string;
  private repeatMinutes: number;

  constructor(options?: {
    levels?: EscalationLevel[];
    lineToken?: string;
    repeatMinutes?: number;
  }) {
    this.levels = options?.levels || DEFAULT_LEVELS;
    this.lineToken = options?.lineToken || process.env.LINE_NOTIFY_TOKEN || "";
    this.repeatMinutes = options?.repeatMinutes || 10;
  }

  setDiscordHandler(fn: (metrics: any, reason: string) => Promise<void>) {
    this.discordFn = fn;
  }

  /** Start escalation for an alert */
  escalate(alertId: string, metrics: any, reason: string) {
    // If already active, skip (avoid duplicate escalation)
    if (this.active.has(alertId)) return;

    const alert: ActiveAlert = {
      id: alertId,
      reason,
      metrics,
      level: 0,
      startedAt: Date.now(),
      timer: null,
    };

    this.active.set(alertId, alert);
    this.executeLevel(alert);
  }

  /** Acknowledge an alert — stops escalation */
  acknowledge(alertId: string): boolean {
    const alert = this.active.get(alertId);
    if (!alert) return false;

    if (alert.timer) clearTimeout(alert.timer);
    this.active.delete(alertId);
    console.log(`[escalation] ${alertId} acknowledged at level ${alert.level}`);
    return true;
  }

  /** Get all active (unacknowledged) alerts */
  getActive(): { id: string; reason: string; level: number; startedAt: number; elapsed: number }[] {
    return [...this.active.values()].map(a => ({
      id: a.id,
      reason: a.reason,
      level: a.level,
      startedAt: a.startedAt,
      elapsed: Math.round((Date.now() - a.startedAt) / 1000),
    }));
  }

  private async executeLevel(alert: ActiveAlert) {
    if (!this.active.has(alert.id)) return;

    const level = this.levels[alert.level];
    if (!level) {
      // All levels exhausted — start repeating
      this.startRepeat(alert);
      return;
    }

    // Execute after delay
    const execute = async () => {
      if (!this.active.has(alert.id)) return;

      console.log(`[escalation] ${alert.id} → L${alert.level + 1} (${level.channel})`);

      switch (level.channel) {
        case "discord":
          if (this.discordFn) {
            await this.discordFn(alert.metrics, `🔺 L${alert.level + 1}: ${alert.reason}`);
          }
          break;

        case "line":
          if (this.lineToken) {
            const msg = `\n🚨 MAW Alert (L${alert.level + 1})\n${alert.reason}\nAcknowledge: POST /api/alerts/acknowledge/${alert.id}`;
            await sendLineNotify(this.lineToken, msg);
          } else {
            console.log("[escalation] LINE token not set, skipping");
          }
          break;

        case "repeat":
          this.startRepeat(alert);
          return;
      }

      // Move to next level
      alert.level++;
      if (alert.level < this.levels.length) {
        const nextDelay = (this.levels[alert.level].delaySeconds - level.delaySeconds) * 1000;
        alert.timer = setTimeout(() => this.executeLevel(alert), Math.max(nextDelay, 1000));
      } else {
        this.startRepeat(alert);
      }
    };

    if (level.delaySeconds === 0) {
      await execute();
    } else if (alert.level === 0) {
      alert.timer = setTimeout(execute, level.delaySeconds * 1000);
    } else {
      await execute();
    }
  }

  private startRepeat(alert: ActiveAlert) {
    if (!this.active.has(alert.id)) return;

    const repeatMs = this.repeatMinutes * 60 * 1000;
    const repeat = async () => {
      if (!this.active.has(alert.id)) return;

      console.log(`[escalation] ${alert.id} — repeat alert`);

      // Fire all channels
      if (this.discordFn) {
        await this.discordFn(alert.metrics, `🔄 Repeat: ${alert.reason} (${Math.round((Date.now() - alert.startedAt) / 60000)}min unack'd)`);
      }
      if (this.lineToken) {
        await sendLineNotify(this.lineToken, `\n🔄 Repeat Alert\n${alert.reason}\nUnacknowledged for ${Math.round((Date.now() - alert.startedAt) / 60000)} minutes`);
      }

      alert.timer = setTimeout(repeat, repeatMs);
    };

    alert.timer = setTimeout(repeat, repeatMs);
  }
}

/** Singleton escalation chain */
let instance: EscalationChain | null = null;

export function getEscalation(): EscalationChain {
  if (!instance) {
    instance = new EscalationChain();
  }
  return instance;
}

export function initEscalation(options?: ConstructorParameters<typeof EscalationChain>[0]): EscalationChain {
  instance = new EscalationChain(options);
  return instance;
}
