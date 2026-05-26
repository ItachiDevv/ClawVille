varying vec2 csm_vUv;

uniform float uTime;
uniform vec3 uColorNear;
uniform vec3 uColorFar;
uniform float uTextureSize;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                        -0.577350269189626,  // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i); // Avoid truncation effects in permutation
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
        + i.x + vec3(0.0, i1.x, 1.0 ));

    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

void main() {

    // Set the current color as the base color.
    vec3 finalColor = csm_FragColor.rgb;
    
    // Set an initial alpha value
    vec3 alpha = vec3(1.0);

    // Invert texture size
    float textureSize = 100.0 - uTextureSize;

    // Generate noise for the base texture
    float noiseBase = snoise(csm_vUv * (textureSize * 2.8) + sin(uTime * 0.3));
    noiseBase = noiseBase * 0.5 + 0.5;
    vec3 colorBase = vec3(noiseBase);

    // Calculate foam effect using smoothstep and thresholding
    vec3 foam = smoothstep(0.08, 0.001, colorBase);
    foam = step(0.5, foam);  // binary step to create foam effect

    // Generate additional noise for waves
    float noiseWaves = snoise(csm_vUv * textureSize + sin(uTime * -0.1));
    noiseWaves = noiseWaves * 0.5 + 0.5;
    vec3 colorWaves = vec3(noiseWaves);

    // Apply smoothstep for wave thresholding
    float threshold = 0.6 + 0.01 * sin(uTime * 2.0);   // threshold for waves oscillates between 0.6 and 0.61
    vec3 waveEffect = 1.0 - (smoothstep(threshold + 0.03, threshold + 0.032, colorWaves) + 
                            smoothstep(threshold, threshold - 0.01, colorWaves));

    // Binary step to increase the wave pattern thickness
    waveEffect = step(0.5, waveEffect);

    // Combine wave and foam effects
    vec3 combinedEffect = min(waveEffect + foam, 1.0);

    // Applying a gradient based on distance
    float vignette = length(csm_vUv - 0.5) * 1.5;
    vec3 baseEffect = smoothstep(0.1, 0.3, vec3(vignette));
    vec3 baseColor = mix(finalColor, uColorFar, baseEffect);

    combinedEffect = min(waveEffect + foam, 1.0);
    combinedEffect = mix(combinedEffect, vec3(0.0), baseEffect);

    // Sample foam to maintain constant alpha of 1.0
    vec3 foamEffect = mix(foam, vec3(0.0), baseEffect);
    
    // Set the final color
    finalColor = (1.0 - combinedEffect) * baseColor + combinedEffect;
    
    // Managing the alpha based on the distance
    alpha = mix(vec3(0.2), vec3(1.0), foamEffect);
    alpha = mix(alpha, vec3(1.0), vignette + 0.5);

    // Output the final color
    csm_FragColor = vec4(finalColor, alpha);
    
}