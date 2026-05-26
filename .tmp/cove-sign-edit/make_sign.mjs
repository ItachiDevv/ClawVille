import sharp from 'sharp';

const W = 512, H = 256;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="glowFar" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <filter id="glowMid" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="#070a14"/>

  <!-- Outer blue glow halo -->
  <g filter="url(#glowFar)" opacity="0.85">
    <text x="${W/2}" y="${H/2 + 28}"
          font-family="'Brush Script MT', 'Lucida Handwriting', cursive"
          font-size="90" font-style="italic" font-weight="bold"
          text-anchor="middle" fill="#2a6dd6">THE COVE</text>
  </g>

  <!-- Mid blue glow -->
  <g filter="url(#glowMid)" opacity="1">
    <text x="${W/2}" y="${H/2 + 28}"
          font-family="'Brush Script MT', 'Lucida Handwriting', cursive"
          font-size="90" font-style="italic" font-weight="bold"
          text-anchor="middle" fill="#5db1ff">THE COVE</text>
  </g>

  <!-- Crisp bright core -->
  <text x="${W/2}" y="${H/2 + 28}"
        font-family="'Brush Script MT', 'Lucida Handwriting', cursive"
        font-size="90" font-style="italic" font-weight="bold"
        text-anchor="middle"
        fill="#eaf6ff"
        stroke="#cfe9ff" stroke-width="0.5">THE COVE</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('C:/Users/newma/Documents/Crypto/ClawVille/.tmp/cove-sign-edit/cove_sign.png');
console.log('wrote');
