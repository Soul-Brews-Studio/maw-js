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
    // Resume if suspended (browser autoplay policy)
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    playTick();
    unlocked = true;
  } catch {}
}

/** Check if audio has been unlocked */
export function isAudioUnlocked() {
  return unlocked;
}

/** Set by store — checked before playing sounds */
let _muted = false;
export function setSoundMuted(m: boolean) { _muted = m; }
export function isSoundMuted() { return _muted; }

