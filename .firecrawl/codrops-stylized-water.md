[![Stylized Water Effects with React Three Fiber](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/stylized-water-with-react-three-fiber.jpg?x52581)](https://tympanus.net/Tutorials/StylizedWater/ "Creating Stylized Water Effects with React Three Fiber Demo")

[Demo](https://tympanus.net/Tutorials/StylizedWater/) [Code](https://github.com/thaslle/stylized-water)

[Ready to become a GSAP expert? Access the world’s most comprehensive GSAP training with 300+ lessons. Enroll now →](https://www.creativecodingclub.com/bundles/creative-coding-club?ref=0d0431)

In this tutorial, I’ll show you how I created a cool, stylized water effect with smooth movement for my React Three Fiber game. I’ll walk you through the planning process, how I kept the style consistent, the challenges I faced, and what went wrong along the way. We’ll cover writing shaders, optimizing 3D assets, and using them efficiently to create an eye-catching effect—all while maintaining good performance.

[![Free GSAP Training](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/FreeGSAPCourse.webp?x52581)\\
\\
**GSAP Express** by Carl Schooff\\
\\
Get started with GSAP fast and learn core animation techniques while building real projects in this free beginner friendly course.](https://www.creativecodingclub.com/courses/FreeGSAP3Express?ref=0d0431)

## How the Idea Came Up

This year, my wife just turned 30, and I wanted to do something special for her: a game inspired by _O Conto da Ilha Desconhecida_ (The Tale of the Unknown Island) by José Saramago, a book she’d been wanting to read for a while. The idea was simple: build an open-world exploration game in React Three Fiber, set on an island where she could explore, find clues, and eventually discover her birthday gift.

![Screenshot of the game showing Maria, the main character, standing on a hill, surrounded by trees, looking at the sea.](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/02-maria-starting-screen.jpg?x52581)

Water plays a huge part in the game—it’s the most visible element of the environment, and since the game is set on an island, it’s all over the place. But here’s the challenge: how do I make the water look awesome without melting the graphics card?

_Water looks pretty cool in the game!_

## Style

I wanted my game to have a cartoonish, stylized aesthetic, and to achieve that, I took inspiration from three main projects: [Coastal World](https://coastalworld.com/), [Elysium](https://elysium.thebenezer.com/), and [Europa](https://store.steampowered.com/app/2214880/Europa/). My goal was for my game to capture that same playful, charming vibe, so I knew exactly the direction I wanted to take.

![Three main inspirations: Coastal World, Elysium, and Europa.](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/04-01-screenshots.jpg?x52581)Coastal World, Elysium and Europa

## Creating Assets

Before we dive into the water effect, we need some 3D assets to start building the environment. First, I created the terrain in Blender by sculpting a subdivided plane mesh. The key here is to create elevations at the center of the mesh while keeping the outer edges flat, maintaining their original position (no height change at the edges).

![A subdivided plane mesh in Blender](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/05-01-assets-terrain.jpg?x52581)

I also added some fun rocks to bring a little extra charm to the scene.

![Quirky rocks made in Blender](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/05-02-assets-rocks.jpg?x52581)

**You’ll notice I didn’t apply any materials to the models yet. That’s intentional**—I’ll be handling the materials directly in React Three Fiber to keep everything looking consistent.

## Setting Up the Environment

**I’ll go step-by-step so you don’t get lost in the process.**

I imported the models I created in Blender, following this [amazing tutorial by Niccolò Fanton, published here on Codrops.](https://tympanus.net/codrops/2025/02/11/building-efficient-three-js-scenes-optimize-performance-while-maintaining-quality/)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/06-01-models-imported-edited.jpg?x52581)

Then, I placed them over a large `planeGeometry` that covers the ground and disappears into the fog. This approach is lighter than scaling our terrain mesh in the X and Z axes, especially since you might want to work with a large number of subdivisions. Here’s simple math: 4 vertices are lighter than hundreds or more.

```jsx
const { nodes } = useGLTF("/models/terrain.glb")

return (
  <group dispose={null}>
    <mesh
      geometry={nodes.plane.geometry}
      material={nodes.plane.material} // We'll replace this default Blender material later
      receiveShadow
    />

    <mesh
      rotation-x={-Math.PI / 2}
      position={[0, -0.01, 0]} // Moved it down to prevent the visual glitch from plane collision
      material={nodes.plane.material} // Using the same material for a seamless look
      receiveShadow
    >
      <planeGeometry args={[256, 256]} />
    </mesh>
  </group>
)
```

![Models imported over a planeGeometry mesh](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/06-02-plane-mesh-edited.jpg?x52581)Looking seamless

Next, I duplicated this `mesh` to serve as the water surface and moved it up to the height I wanted for the water level.

![PlaneGeometry Mesh serving as water surface](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/06-03-water-edited.jpg?x52581)I used a light blue color to see the difference between the planes.

Since this `waterLevel` will be used in other components, I set up a `store` with [Zustand](https://zustand.docs.pmnd.rs/) to easily manage and access the water level throughout the game. This way, we can tweak the values and see the changes reflected across the entire game, which is something I really enjoy doing!

```jsx
import { create } from "zustand"
export const useStore = create((set) => ({
  waterLevel: 0.9,
}))
```

```jsx
const waterLevel = useStore((state) => state.waterLevel)

return (
  <mesh rotation-x={-Math.PI / 2} position-y={waterLevel}>
    <planeGeometry args={[256, 256]} />
    <meshStandardMaterial color="lightblue" />
  </mesh>
)
```

## Clay Materials? Not Anymore!

As mentioned earlier, we’ll handle the materials in React Three Fiber, and now it’s time to get started. Since we’ll be writing some shaders, let’s use the [Custom Shader Material library](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial), which allows us to extend Three.js materials with our own vertex and fragment shaders. It’s much simpler than using `onBeforeCompile` and requires far less code.

### Set Up

Let’s start with the terrain. I picked three colors to use here: Sand, Grass, and Underwater. First, we apply the sand color as the base color for the terrain and pass `waterLevel`, `GRASS_COLOR`, and `UNDERWATER_COLOR` as uniforms to the shader.

It’s time to start using the `useControls` hook from [Leva](https://github.com/pmndrs/leva) to add a GUI, which lets us see the changes immediately.

```jsx
// Interactive color parameters
const { SAND_BASE_COLOR, GRASS_BASE_COLOR, UNDERWATER_BASE_COLOR } =
  useControls("Terrain", {
    SAND_BASE_COLOR: { value: "#ff9900", label: "Sand" },
    GRASS_BASE_COLOR: { value: "#85a02b", label: "Grass" },
    UNDERWATER_BASE_COLOR: { value: "#118a4f", label: "Underwater" }
  })

// Convert color hex values to Three.js Color objects
const GRASS_COLOR = useMemo(
  () => new THREE.Color(GRASS_BASE_COLOR),
  [GRASS_BASE_COLOR]
)
const UNDERWATER_COLOR = useMemo(
  () => new THREE.Color(UNDERWATER_BASE_COLOR),
  [UNDERWATER_BASE_COLOR]
)

// Material
const materialRef = useRef()

// Update shader uniforms whenever control values change
useEffect(() => {
  if (!materialRef.current) return

  materialRef.current.uniforms.uGrassColor.value = GRASS_COLOR
  materialRef.current.uniforms.uUnderwaterColor.value = UNDERWATER_COLOR
  materialRef.current.uniforms.uWaterLevel.value = waterLevel
}, [\
  GRASS_COLOR,\
  UNDERWATER_COLOR,\
  waterLevel\
])
```

```jsx
<mesh geometry={nodes.plane.geometry} receiveShadow>
  <CustomShaderMaterial
    ref={materialRef}
    baseMaterial={THREE.MeshStandardMaterial}
    color={SAND_BASE_COLOR}
    vertexShader={vertexShader}
    fragmentShader={fragmentShader}
    uniforms={{
      uTime: { value: 0 },
      uGrassColor: { value: GRASS_COLOR },
      uUnderwaterColor: { value: UNDERWATER_COLOR },
      uWaterLevel: { value: waterLevel }
    }}
  />
</mesh>
```

We also apply the `UNDERWATER_COLOR` to the large `planeGeometry` we created for the ground, ensuring that the two elements blend seamlessly.

```jsx
<mesh
  rotation-x={-Math.PI / 2}
  position={[0, -0.01, 0]}
  receiveShadow
>
  <planeGeometry args={[256, 256]} />
  <meshStandardMaterial color={UNDERWATER_BASE_COLOR} />
</mesh>
```

Note: As you’ll see, I use `capitalCase` for global values that come directly from `useStore` hook and `UPPERCASE` for values controlled by Leva.

### **Vertex and Fragment Shader**

So far, so good. Now, let’s create the `vertexShader` and `fragmentShader`.

Here we need to use the `csm_` prefix because Custom Shader Material extends an existing material from Three.js. This way, our custom varyings won’t conflict with any others that might already be declared on the extended material.

```cpp
// Vertex Shader

varying vec3 csm_vPositionW;
void main() {
  csm_vPositionW = (modelMatrix * vec4(position, 1.0)).xyz;
}
```

In the code above, we’re passing the vertex position information to the `fragmentShader` by using a `varying` named `csm_vPositionW`. This allows us to access the world position of each vertex in the `fragmentShader`, which will be useful for creating effects based on the vertex’s position in world space.

In the `fragmentShader`, we use `uWaterLevel` as a threshold combined with `csm_vPositionW.y`, so when `uWaterLevel` changes, everything reacts accordingly.

```cpp
// Fragment Shader

varying vec3 csm_vPositionW;
uniform float uWaterLevel;
uniform vec3 uGrassColor;
uniform vec3 uUnderwaterColor;

void main() {

    // Set the current color as the base color
    vec3 baseColor = csm_DiffuseColor.rgb;

    // Darken the base color at lower Y values to simulate wet sand
    float heightFactor = smoothstep(uWaterLevel + 1.0, uWaterLevel, csm_vPositionW.y);
    baseColor = mix(baseColor, baseColor * 0.5, heightFactor);

    // Blend underwater color with base planeMesh to add depth to the ocean bottom
    float oceanFactor = smoothstep(min(uWaterLevel - 0.4, 0.2), 0.0, csm_vPositionW.y);
    baseColor = mix(baseColor, uUnderwaterColor, oceanFactor);

    // Add grass to the higher areas of the terrain
    float grassFactor = smoothstep(uWaterLevel + 0.8, max(uWaterLevel + 1.6, 3.0), csm_vPositionW.y);
    baseColor = mix(baseColor, uGrassColor, grassFactor);

    // Output the final color
    csm_DiffuseColor = vec4(baseColor, 1.0);
}
```

What I love most about using world position to tweak elements is how it lets us create dynamic visuals, like beautiful gradients that react to the environment.

For example, **we darkened the sand near the water level to give the effect of wet sand**, which adds a nice touch. Plus, we added grass that grows based on an offset from the water level.

Here’s what it looks like (I’ve hidden the water for now so we can see the results more clearly)

![Terrain model with colors applied](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/06-04-terrain-edited.jpg?x52581)The dark greenish-blue on the ground will help us to add depth to the scene

We can apply a similar effect to the rocks, but this time using a green color to simulate moss growing on them.

```cpp
varying vec3 csm_vPositionW;

uniform float uWaterLevel;
uniform vec3 uMossColor;

void main() {

    // Set the current color as the base color
    vec3 baseColor = csm_DiffuseColor.rgb;

    // Paint lower Y with a different color to simulate moss
    float mossFactor = smoothstep(uWaterLevel + 0.3, uWaterLevel - 0.05, csm_vPositionW.y);
    baseColor = mix(baseColor, uMossColor, mossFactor);

    // Output the final color
    csm_DiffuseColor = vec4(baseColor, 1.0);
}
```

![Rocks with a moss-like effect](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/06-05-rocks-edited.jpg?x52581)It adds personality to the scene—so simple, yet so cozy

## Water, Finally

It was high time to add the water, **making sure it looks great and feels interactive.**

### Animating Water Flow

To start, I wanted the water to slowly move up and down, like gentle tidal waves. To achieve this, we pass a few values to the `vertexShader` as uniforms:

- `uTime` to animate the vertices based on the time passed (this allows us to create continuous motion)
- `uWaveSpeed` and `uWaveAmplitude` to control the speed and size of the wave movement.

Let’s do it step-by-step

1\. Set up the values globally in `useStore`, as it will be handy later.

```jsx
// useStore.js
import { create } from "zustand"

export const useStore = create((set) => ({
  waterLevel: 0.9,
  waveSpeed: 1.2,
  waveAmplitude: 0.1
}))
```

2\. Add Leva controls to see the changes live

```jsx
// Global states
const waterLevel = useStore((state) => state.waterLevel)
const waveSpeed = useStore((state) => state.waveSpeed)
const waveAmplitude = useStore((state) => state.waveAmplitude)

// Interactive water parameters
const {
  COLOR_BASE_NEAR, WATER_LEVEL, WAVE_SPEED, WAVE_AMPLITUDE
} = useControls("Water", {
  COLOR_BASE_NEAR: { value: "#00fccd", label: "Near" },
  WATER_LEVEL: { value: waterLevel, min: 0.5, max: 5.0, step: 0.1, label: "Water Level" },
  WAVE_SPEED: { value: waveSpeed, min: 0.5, max: 2.0, step: 0.1, label: "Wave Speed" },
  WAVE_AMPLITUDE: { value: waveAmplitude, min: 0.05, max: 0.5, step: 0.05, label: "Wave Amplitude" },
})
```

3\. Add the uniforms to the Custom Shader Material

```jsx
<CustomShaderMaterial
  ref={materialRef}
  baseMaterial={THREE.MeshStandardMaterial}
  vertexShader={vertexShader}
  fragmentShader={fragmentShader}
  uniforms={{
    uTime: { value: 0 },
    uWaveSpeed: { value: WAVE_SPEED },
    uWaveAmplitude: { value: WAVE_AMPLITUDE }
  }}
  color={COLOR_BASE_NEAR}
  transparent
  opacity={0.4}
/>
```

4\. Handle the value updates

```jsx
// Update shader uniforms whenever control values change
useEffect(() => {
  if (!materialRef.current) return
  materialRef.current.uniforms.uWaveSpeed.value = WAVE_SPEED
  materialRef.current.uniforms.uWaveAmplitude.value = WAVE_AMPLITUDE
}, [WAVE_SPEED, WAVE_AMPLITUDE])

// Update shader time
useFrame(({ clock }) => {
  if (!materialRef.current) return
  materialRef.current.uniforms.uTime.value = clock.getElapsedTime()
})
```

5\. Don’t forget to update the global values so other components can share the same settings

```jsx
// Update global states
useEffect(() => {
  useStore.setState(() => ({
    waterLevel: WATER_LEVEL,
    waveSpeed: WAVE_SPEED,
    waveAmplitude: WAVE_AMPLITUDE
  }))
}, [WAVE_SPEED, WAVE_AMPLITUDE, WATER_LEVEL])
```

Then, in the `vertexShader`, we use those values to move all the vertices up and down. Moving vertices in the `vertexShader` is usually faster than animating it with `useFrame` because it runs directly on the GPU, which is much better suited for handling these kinds of tasks.

```cpp
varying vec2 csm_vUv;

uniform float uTime;
uniform float uWaveSpeed;
uniform float uWaveAmplitude;

void main() {
  // Send the uv coordinates to fragmentShader
  csm_vUv = uv;

  // Modify the y position based on sine function, oscillating up and down over time
  float sineOffset = sin(uTime * uWaveSpeed) * uWaveAmplitude;

  // Apply the sine offset to the y component of the position
  vec3 modifiedPosition = position;
  modifiedPosition.z += sineOffset; // z used as y because element is rotated

  csm_Position = modifiedPosition;
}
```

It’s looking nice already, but now we need to add a cool water surface!

### Crafting the Water Surface

At this point, I wanted to give my water the same look as [Coastal World](https://coastalworld.com/), with foam-like spots and a wave pattern that had a _cartoonish_ feel. Plus, the pattern needed to move to make it feel like real water!

I spent some time thinking about how to achieve this without sacrificing performance. Using a texture map was out of the question, since we’re working with a large plane mesh. Using a big texture would have been too heavy and likely resulted in blurry pattern edges.

Fortunately, I came across this [amazing article](https://mercimichel.medium.com/coastal-world-8f23b945823b) by the Merci Michel team (the incredible creators of Coastal World) explaining how they handled it there. So my goal was to try and recreate that effect with my own twist.

Essentially, it’s a mix of _Perlin noise\*_, `smoothStep`, sine functions, and a lot of creativity!

_\\* Perlin noise is a smooth, random noise used in graphics to create natural-looking patterns, like terrain or clouds, with softer, more organic transitions than regular random noise._

**Let’s break it down to understand it better:**

First, I added two new uniforms to my shader: `uTextureSize` and `uColorFar`. These let us control the texture’s dimensions and create the effect of the sea color changing the further it is from the camera.

By now, you should be familiar with creating controls using Leva and passing them as uniforms. Let’s jump right into the shader.

```cpp
varying vec2 csm_vUv;

uniform float uTime;
uniform vec3 uColorNear;
uniform vec3 uColorFar;
uniform float uTextureSize;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v) {
    ...
    // The Perlin noise code is a bit lengthy, so I’ve omitted it here.
    // You can find the full code by the wizard Patricio Gonzalez Vivo at
    // https://thebookofshaders.com/edit.php#11/lava-lamp.frag
}
```

The key here is using the `smoothStep` function to extract a small range of gray from our Perlin noise texture. This gives us a wave-like pattern. We can combine these values in all kinds of ways to create different effects.

**First, the basic approach:**

```cpp
// Generate noise for the base texture
float noiseBase = snoise(csm_vUv);

// Normalize the values
vec3 colorWaves = noiseBase * 0.5 + 0.5;

// Apply smoothstep for wave thresholding
vec3 waveEffect = 1.0 - (smoothstep(0.53, 0.532, colorWaves) + smoothstep(0.5, 0.49, colorWaves));
```

**Now, with all the effects combined:**

```cpp
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
    // Threshold for waves oscillates between 0.6 and 0.61
    float threshold = 0.6 + 0.01 * sin(uTime * 2.0);
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
```

The secret here is to apply the `uTime` uniform to our Perlin noise texture, then use a `sin` function to make it move back and forth, creating that flowing water effect.

```cpp
// We use uTime to make the Perlin noise texture move
float noiseWaves = snoise(csm_vUv * textureSize + sin(uTime * -0.1));

...

// We can also use uTime to make the pattern shape dynamic
float threshold = 0.6 + 0.01 * sin(uTime * 2.0);
vec3 waveEffect = 1.0 - (smoothstep(threshold + 0.03, threshold + 0.032, colorWaves) +
                         smoothstep(threshold, threshold - 0.01, colorWaves));
```

Pretty nice, right?

But we still need the final touch: the **intersection foam effect**. This is the white, foamy texture that appears where the water touches other objects, like rocks or the shore.

![Intersection foam effect](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/07-04-foam.jpg?x52581)

## Failed Foam Effect

After doing some research, I found this [fancy solution](https://codesandbox.io/p/sandbox/7rkse) that uses a `RenderTarget` and `depthMaterial` to create the foam effect (which, as I later realized, is a go-to solution for effects like the one I was aiming for).

Here’s a breakdown of this approach: the `RenderTarget` captures the depth of the scene, and the `depthMaterial` applies that depth data to generate foam where the water meets other objects. It seemed like the perfect way to achieve the visual effect I had in mind.

But after implementing it, I quickly realized that while the effect looked great, the performance was bad.

![Frame drop](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/08-01-framedrop-art-400x225.jpg?x52581)Well, it didn’t freeze like that, but in my mind, it did

The issue here is that it’s computationally expensive—rendering the scene to an offscreen buffer and calculating depth requires extra GPU passes. On top of that, it doesn’t work well with transparent materials, which caused problems in my scene.

So, after testing it and seeing the performance drop, I had to rethink the approach and come up with a new solution.

## It’s all an Illusion

![Phil Dunphy doing a magic trick](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/09-01-phil-dunphy.webp?x52581)

Anyone who’s into game development knows that many of the cool effects we see on screen are actually clever illusions. And this one is no different.

I was watching [Bruno Simon’s Devlog](https://youtu.be/MXpML0B2MJc?si=W-M-4SVm18jy8F0a) when he mentioned the perfect solution: painting a white stripe exactly at the water level on every object in contact with the water (actually, he used a gradient, but I personally prefer stripes). Later, I realized that Coastal World, as mentioned in the article, does the exact same thing. But at the time I read the article, I wasn’t quite prepared to take in that knowledge.

![Mr. Miyagi teaching Daniel-san a lesson](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/09-02-karate-kid-miyagi.webp?x52581)

So, I ended up using the same function I wrote to move the water vertices in the `vertexShader` and applied it to the terrain and rocks fragment shaders with some tweaks.

### Step-by-Step Process:

1\. First, I added `foamDepth` to our global store alongside the `waterLevel`, `waveSpeed`, and `waveAmplitude`, because these values need to be accessible across all elements in the scene.

```cpp
import { create } from "zustand"

export const useStore = create((set) => ({
  waterLevel: 0.9,
  waveSpeed: 1.2,
  waveAmplitude: 0.1,
  foamDepth: 0.05,
}))
```

2\. Then, we pass these uniforms to the `fragmentShader` of each material that needs the foam effect.

```jsx
// Global states
const waterLevel = useStore((state) => state.waterLevel)
const waveSpeed = useStore((state) => state.waveSpeed)
const waveAmplitude = useStore((state) => state.waveAmplitude)
const foamDepth = useStore((state) => state.foamDepth)

...

<CustomShaderMaterial
  ...
  uniforms={{
    uTime: { value: 0 },
    uWaterLevel: { value: waterLevel },
    uWaveSpeed: { value: waveSpeed },
    uWaveAmplitude: { value: waveAmplitude }
    uFoamDepth: { value: foamDepth },
    ...
  }}
/>
```

3\. Finally, at the end of our `fragmentShader`, we add the functions that draw the stripe, as you can see above.

### How it works:

1\. First, we synchronize the water movement using `uWaterLevel`, `uWaterSpeed`, `uWaterAmplitude`, and `uTime`.

```cpp
// Foam Effect
// Get the y position based on sine function, oscillating up and down over time
float sineOffset = sin(uTime * uWaveSpeed) * uWaveAmplitude;

// The current dynamic water height
float currentWaterHeight = uWaterLevel + sineOffset;
```

2\. Then, we use `smoothStep` to create a white stripe with a thickness of `uFoamDepth` based on `csm_vPositionW.y`. It’s the same approach we used for the wet sand, moss and grass, but now it’s in motion.

```cpp
float stripe = smoothstep(currentWaterHeight + 0.01, currentWaterHeight - 0.01, csm_vPositionW.y)
               - smoothstep(currentWaterHeight + uFoamDepth + 0.01, currentWaterHeight + uFoamDepth - 0.01, csm_vPositionW.y);

vec3 stripeColor = vec3(1.0, 1.0, 1.0); // White stripe

// Apply the foam strip to baseColor
vec3 finalColor = mix(baseColor - stripe, stripeColor, stripe);

// Output the final color
csm_DiffuseColor = vec4(finalColor, 1.0);
```

And that’s it! Now we can tweak the values to get the best visuals.

## You Thought I Was Done? Not Quite Yet!

I thought it would be fun to add some sound to the experience. So, I picked two audio files, one with the sound of waves crashing and another with birds singing. Sure, maybe there aren’t any birds on such a remote island, but the vibe felt right.

For the sound, I used the `PositionalAudio` [library from Drei](https://drei.docs.pmnd.rs/abstractions/positional-audio), which is awesome for adding 3D sound to the scene. With it, we can place the audio exactly where we want it to come from, creating an immersive experience.

```jsx
<group position={[0, 0, 0]}>
  <PositionalAudio
    autoplay
    loop
    url="/sounds/waves.mp3"
    distance={50}
  />
</group>

<group position={[-65, 35, -55]}>
  <PositionalAudio
    autoplay
    loop
    url="/sounds/birds.mp3"
    distance={30}
  />
</group>
```

And voilà!

Now, it’s important to note that **browsers don’t let us play audio until the user interacts with the page.** So, to handle that, I added a global state `audioEnabled` to manage the audio, and created a button to enable sound when the user clicks on it.

```jsx
import { create } from "zustand"

export const useStore = create((set) => ({
  ...
  audioEnabled: false,

  setAudioEnabled: (enabled) => set(() => ({ audioEnabled: enabled })),
  setReady: (ready) => set(() => ({ ready: ready }))
}))
```

```jsx
const audioEnabled = useStore((state) => state.audioEnabled)
const setAudioEnabled = useStore((state) => state.setAudioEnabled)

const handleSound = () => {
  setAudioEnabled(!audioEnabled)
}

return <button onClick={() => handleSound()}>Enable sound</button>
```

```jsx
const audioEnabled = useStore((state) => state.audioEnabled)

return (
  audioEnabled && (
    <>
      <group position={[0, 0, 0]}>
        <PositionalAudio
          autoplay
          loop
          url="/sounds/waves.mp3"
          distance={50}
        />
      </group>

      <group position={[-65, 35, -55]}>
        <PositionalAudio
          autoplay
          loop
          url="/sounds/birds.mp3"
          distance={30}
        />
      </group>
    </>
  )
)
```

Then, I used a mix of CSS animations to make everything come together.

## Conclusion

And that’s it! In this tutorial, I’ve walked you through the steps I took to create a unique water effect for my game, which I made as a birthday gift for my wife. If you’re curious about her reaction, you can check it out on my [Instagram](https://www.instagram.com/thaslle/reel/DGCL1ngN_dz/), and feel free to try the [live version of the game](https://maria30.vercel.app/).

This project gives you a solid foundation for creating stylized water and shaders in React Three Fiber, and you can use it as a base to experiment and build even more complex environments. Whether you’re working on a personal project or diving into something bigger, the techniques I’ve shared can be adapted and expanded to suit your needs.

If you have any questions or feedback, I’d love to hear from you! Thanks for following along, and happy coding! 🎮

[3D](https://tympanus.net/codrops/tag/3d/) [React Three Fiber](https://tympanus.net/codrops/tag/react-three-fiber/) [Three.js](https://tympanus.net/codrops/tag/three-js/) [WebGL](https://tympanus.net/codrops/tag/webgl/)

![](https://secure.gravatar.com/avatar/d193d8cebf6dedda1292dcf2e053d35e0ef60bdd71e98de26c65ee599e102707?s=160&d=retro&r=g)

### [Thalles Lopes](https://tympanus.net/codrops/author/thalleslopesm/)

Creative Frontend Developer with expertise in crafting interactive 3D experiences, coding, and illustration

- [Website](https://thalles.work/)
- [LinkedIn](https://www.linkedin.com/in/thaslle)
- [Github](https://github.com/thaslle)

### Creative Spotlights

Inside the journeys and portfolios of today's most inspiring [designers](https://tympanus.net/codrops/tag/designer-spotlight/) and [developers](https://tympanus.net/codrops/tag/developer-spotlight/).

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/11/DSC_0112-awwwards-160x160.jpg?x52581)

![](https://secure.gravatar.com/avatar/f1b0cc5150146515b715a7ee44b8d15b84ae1eb088fcc44d8a7130ae1c0a8d95?s=160&d=retro&r=g)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/02/IMG_3840-scaled-160x160.jpg?x52581)

![](https://secure.gravatar.com/avatar/99b569addccce6ea8f1590f7235496ce07cd80f8718b640946e13da4f75e782e?s=160&d=retro&r=g)

![](https://secure.gravatar.com/avatar/c05ec8c4a1421cac11613d4bd233dc469791b790a1119e83bed9492b226f3784?s=160&d=retro&r=g)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/03/CorentinBernadou_Profile-160x160.jpg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/07/photo-profil-160x160.png?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/03/huy-160x160.jpeg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/08/profile-160x160.jpg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/08/andres-160x160.jpeg?x52581)

![](https://secure.gravatar.com/avatar/38c09524b21fd8d80cb1440c8132212f38ec882b078239b83a121b55d12e49c2?s=160&d=retro&r=g)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/01/db-social-pf-160x160.jpg?x52581)

### [Studio Stories](https://tympanus.net/codrops/tag/studio-spotlight/)

Discover how studios & agencies started, how they work, and what they've built.

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/02/naughtyduk_logo-160x160.jpeg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/06/Malvah_Logo-160x160.png?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/02/forged-160x160.jpeg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/logo-1-160x160.jpg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/11/b2sBj1rG_400x400-160x160.jpg?x52581)

![](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2025/11/14islands_profile-160x160.jpg?x52581)

### [Case Studies](https://tympanus.net/codrops/tag/case-study/)

Discover the ideas, design, and craft behind today’s most inspiring web experiences.

### [Learn with Tutorials](https://tympanus.net/codrops/category/tutorials/)

Level up your front-end skills with practical, step-by-step tutorials.

[![Free GSAP Training](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/FreeGSAPCourse.webp?x52581)\\
\\
**GSAP Express** by Carl Schooff\\
\\
Get started with GSAP fast and learn core animation techniques while building real projects in this free beginner friendly course.](https://www.creativecodingclub.com/courses/FreeGSAP3Express?ref=0d0431)

[![Learn the Astro Web Framework](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/Learn-Astro-400x225.webp?x52581)\\
\\
**Learn the Astro Web Framework** by Chris Pennington\\
\\
A premium interactive video course for building modern websites using the Astro web framework trusted by more than 1700 students.\\
\\
20% offUse “C0DROP3”](https://learnastro.dev/?code=C0DROP3)

[![Master GSAP Web Animation](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/gsapcodingclub-400x224.webp?x52581)\\
\\
**Master GSAP Web Animation** by Carl Schooff\\
\\
Level up your GSAP skills with 300+ lessons covering essential features and techniques for creating and controlling animations more effectively.\\
\\
20% offUse “CDRPS”](https://www.creativecodingclub.com/bundles/creative-coding-club?ref=0d0431)

[![Three.js Journey](https://codrops-1f606.kxcdn.com/codrops/wp-content/uploads/2026/04/threejsjourney-1-400x225.webp?x52581)\\
\\
**Three.js Journey** by Bruno Simon\\
\\
Master Three.js with 93 hours of hands-on lessons. Build stunning 3D web experiences from scratch and level up your dev skills fast.](https://threejs-journey.com/)