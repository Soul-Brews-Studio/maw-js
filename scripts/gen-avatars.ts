#!/usr/bin/env bun
/**
 * Generate PNG avatar sprites from the same SVG logic as AgentAvatar.tsx
 * Output: dist-wasm-office/avatars/<name>.png (128x128)
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync } from "fs";

const OUT_DIR = import.meta.dir + "/../dist-wasm-office/avatars";
mkdirSync(OUT_DIR, { recursive: true });

const AGENTS: Record<string, string> = {
  "neo-oracle": "#64b5f6",
  "nexus-oracle": "#81c784",
  "hermes-oracle": "#ffb74d",
  "pulse-oracle": "#4dd0e1",
  "homelab-oracle": "#90caf9",
  "arthur-oracle": "#ff8a65",
  "dustboy-oracle": "#a1887f",
  "floodboy-oracle": "#4dd0e1",
  "fireman-oracle": "#ef5350",
  "dustboy-chain-oracle": "#66bb6a",
  "xiaoer-oracle": "#f48fb1",
  "maeon-oracle": "#fdd835",
  "mother-oracle": "#ce93d8",
  "landing-oracle": "#ff8a65",
  "odin-oracle": "#b39ddb",
  "volt-oracle": "#fdd835",
  "skills-cli-oracle": "#4dd0e1",
  "oracle-v2": "#64b5f6",
  "hermes-bitkub": "#ffb74d",
  "hermes-psru": "#ffb74d",
};

function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function genSvg(name: string, color: string): string {
  const h = nameHash(name);
  const hasEars = h % 3 === 0;
  const hasAntenna = !hasEars && h % 3 === 1;
  const eyeStyle = (h >> 4) % 3;
  const statusColor = "#4caf50"; // ready

  let ears = "";
  if (hasEars) {
    ears = `
      <polygon points="-14,-24 -18,-36 -6,-28" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <polygon points="14,-24 18,-36 6,-28" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <polygon points="-13,-25 -16,-33 -8,-27" fill="#ffb4b4" opacity="0.4"/>
      <polygon points="13,-25 16,-33 8,-27" fill="#ffb4b4" opacity="0.4"/>`;
  }

  let antenna = "";
  if (hasAntenna) {
    antenna = `
      <line x1="0" y1="-30" x2="0" y2="-40" stroke="#888" stroke-width="1.5"/>
      <circle cx="0" cy="-42" r="3" fill="${statusColor}"/>`;
  }

  let eyes = "";
  if (eyeStyle === 0) {
    eyes = `
      <circle cx="-7" cy="-12" r="4.5" fill="#fff"/>
      <circle cx="7" cy="-12" r="4.5" fill="#fff"/>
      <circle cx="-6" cy="-12" r="2.5" fill="#222"/>
      <circle cx="8" cy="-12" r="2.5" fill="#222"/>
      <circle cx="-5" cy="-13.5" r="1" fill="#fff"/>
      <circle cx="9" cy="-13.5" r="1" fill="#fff"/>`;
  } else if (eyeStyle === 1) {
    eyes = `
      <path d="M -10 -12 Q -7 -15 -4 -12" fill="none" stroke="#222" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M 4 -12 Q 7 -15 10 -12" fill="none" stroke="#222" stroke-width="1.8" stroke-linecap="round"/>`;
  } else {
    eyes = `
      <circle cx="-7" cy="-12" r="4.5" fill="#fff"/>
      <circle cx="7" cy="-12" r="4.5" fill="#fff"/>
      <text x="-7" y="-9.5" text-anchor="middle" fill="${color}" font-size="7" font-weight="bold">*</text>
      <text x="7" y="-9.5" text-anchor="middle" fill="${color}" font-size="7" font-weight="bold">*</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="-32 -50 64 80">
    <!-- Aura -->
    <circle cx="0" cy="-6" r="28" fill="${statusColor}" opacity="0.06"/>
    <ellipse cx="0" cy="24" rx="18" ry="4" fill="${statusColor}" opacity="0.15"/>

    <!-- Ground shadow -->
    <ellipse cx="0" cy="24" rx="16" ry="4" fill="${statusColor}" opacity="0.2"/>

    <!-- Body (hoodie) -->
    <rect x="-12" y="6" width="24" height="18" rx="8" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.9"/>
    <rect x="-6" y="14" width="12" height="5" rx="2" fill="#000" opacity="0.12"/>

    <!-- Head -->
    <circle cx="0" cy="-10" r="20" fill="${color}" stroke="#fff" stroke-width="2"/>

    <!-- Hair tuft -->
    <ellipse cx="-4" cy="-28" rx="6" ry="4" fill="${color}" stroke="#fff" stroke-width="1"/>
    <ellipse cx="4" cy="-29" rx="5" ry="3" fill="${color}" stroke="#fff" stroke-width="1"/>

    ${ears}
    ${antenna}
    ${eyes}

    <!-- Blush -->
    <ellipse cx="-12" cy="-7" rx="3" ry="2" fill="#ff9999" opacity="0.25"/>
    <ellipse cx="12" cy="-7" rx="3" ry="2" fill="#ff9999" opacity="0.25"/>

    <!-- Mouth -->
    <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" stroke-width="1.2" stroke-linecap="round"/>

    <!-- Headphones -->
    <path d="M -17 -14 Q -18 -28 0 -30 Q 18 -28 17 -14" fill="none" stroke="#555" stroke-width="2.5"/>
    <rect x="-20" y="-18" width="6" height="10" rx="3" fill="#444" stroke="#555" stroke-width="1"/>
    <rect x="14" y="-18" width="6" height="10" rx="3" fill="#444" stroke="#555" stroke-width="1"/>

    <!-- Mic -->
    <line x1="-19" y1="-10" x2="-14" y2="-2" stroke="#555" stroke-width="1.2"/>
    <circle cx="-13" cy="-1" r="1.5" fill="#666"/>

    <!-- Arms -->
    <line x1="-12" y1="10" x2="-16" y2="20" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
    <line x1="12" y1="10" x2="16" y2="20" stroke="${color}" stroke-width="3" stroke-linecap="round"/>

    <!-- Legs -->
    <line x1="-5" y1="23" x2="-6" y2="28" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="5" y1="23" x2="6" y2="28" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>

    <!-- Shoes -->
    <ellipse cx="-7" cy="29" rx="3.5" ry="2" fill="#333"/>
    <ellipse cx="7" cy="29" rx="3.5" ry="2" fill="#333"/>

    <!-- Status dot -->
    <circle cx="16" cy="-28" r="3.5" fill="${statusColor}" stroke="#1a1a1a" stroke-width="1.5"/>
  </svg>`;
}

let count = 0;
for (const [target, color] of Object.entries(AGENTS)) {
  const svg = genSvg(target, color);
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 512 } });
  const png = resvg.render().asPng();
  const name = target.replace(/-oracle$/, "");
  await Bun.write(`${OUT_DIR}/${name}.png`, png);
  count++;
  console.log(`  ✓ ${name}.png (${png.length} bytes)`);
}
console.log(`\n✓ ${count} avatars generated in dist-wasm-office/avatars/`);
