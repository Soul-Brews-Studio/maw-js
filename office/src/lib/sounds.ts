// Sound effects for Oracle Office

// Audio context — unlocked by user interaction
let audioCtx: AudioContext | null = null;
let unlocked = false;

/** Generate a short tick sound via Web Audio API */
function playTick() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 1200;
  osc.type = "sine";
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

/** Unlock audio on first user click/tap — plays a small tick so human knows sound is on */
export function unlockAudio() {
  if (unlocked) return;
  try {
    audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    playTick();
    unlocked = true;
  } catch {}
}

export function isAudioUnlocked() { return unlocked; }

/** Set by store — checked before playing sounds */
let _muted = false;
export function setSoundMuted(m: boolean) { _muted = m; }
export function isSoundMuted() { return _muted; }

// --- Sound profiles ---

export type SoundProfile = "saiyan" | "ping" | "chime" | "bell" | "none";

export const SOUND_PROFILES: { id: SoundProfile; label: string; emoji: string }[] = [
  { id: "saiyan", label: "Super Saiyan", emoji: "⚡" },
  { id: "ping", label: "Ping", emoji: "🔔" },
  { id: "chime", label: "Chime", emoji: "🎵" },
  { id: "bell", label: "Bell", emoji: "🔕" },
  { id: "none", label: "Silent", emoji: "🤫" },
];

let _soundProfile: SoundProfile = (localStorage.getItem("office-sound") as SoundProfile) || "ping";
export function getSoundProfile() { return _soundProfile; }
export function setSoundProfile(p: SoundProfile) {
  _soundProfile = p;
  localStorage.setItem("office-sound", p);
}

// --- Saiyan (MP3) ---
const saiyanSounds = ["/office/saiyan.mp3", "/office/saiyan-aura.mp3", "/office/saiyan-rose.mp3", "/office/saiyan-2.mp3"];
const SAIYAN_MAX_PLAY = 3;
const SAIYAN_FADE_MS = 1500;

function playSaiyanInternal() {
  try {
    const src = saiyanSounds[Math.floor(Math.random() * saiyanSounds.length)];
    const audio = new Audio(src);
    audio.volume = 0.3;
    audio.play().catch(() => {});
    setTimeout(() => {
      const startVol = audio.volume;
      const steps = 30;
      const stepMs = SAIYAN_FADE_MS / steps;
      let step = 0;
      const fade = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol * (1 - step / steps));
        if (step >= steps) { clearInterval(fade); audio.pause(); }
      }, stepMs);
    }, SAIYAN_MAX_PLAY * 1000);
  } catch {}
}

// --- Synthesized sounds (Web Audio API) ---

function playPing() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.setValueAtTime(1320, t + 0.08);
  osc.type = "sine";
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.start(t);
  osc.stop(t + 0.3);
}

function playChime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [523, 659, 784].forEach((freq, i) => {
    const osc = audioCtx!.createOscillator();
    const gain = audioCtx!.createGain();
    osc.connect(gain);
    gain.connect(audioCtx!.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    const start = t + i * 0.12;
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}

function playBell() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 600;
  osc.type = "triangle";
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  osc.start(t);
  osc.stop(t + 0.6);
}

/** Play notification sound based on current profile */
export function playNotificationSound() {
  if (!unlocked || _muted) return;
  switch (_soundProfile) {
    case "saiyan": playSaiyanInternal(); break;
    case "ping": playPing(); break;
    case "chime": playChime(); break;
    case "bell": playBell(); break;
    case "none": break;
  }
}

/** Preview a sound profile */
export function previewSound(profile: SoundProfile) {
  if (!unlocked) return;
  const prev = _muted;
  _muted = false;
  const prevProfile = _soundProfile;
  _soundProfile = profile;
  playNotificationSound();
  _soundProfile = prevProfile;
  _muted = prev;
}
