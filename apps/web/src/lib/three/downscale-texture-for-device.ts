import * as THREE from 'three';

type DimensionedImage = {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly naturalWidth?: unknown;
  readonly naturalHeight?: unknown;
  readonly videoWidth?: unknown;
  readonly videoHeight?: unknown;
  readonly complete?: unknown;
};

function positiveDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readImageDimensions(image: unknown): readonly [number, number] | null {
  if (!image || typeof image !== 'object') return null;
  const candidate = image as DimensionedImage;
  if (candidate.complete === false) return null;

  const width =
    positiveDimension(candidate.naturalWidth)
    ?? positiveDimension(candidate.videoWidth)
    ?? positiveDimension(candidate.width);
  const height =
    positiveDimension(candidate.naturalHeight)
    ?? positiveDimension(candidate.videoHeight)
    ?? positiveDimension(candidate.height);
  return width === null || height === null ? null : [width, height];
}

function closeBitmap(image: ImageBitmapSource): void {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    try { image.close(); } catch { /* best-effort failed-result cleanup */ }
  }
}

function resizeWithCanvas(
  image: ImageBitmapSource,
  width: number,
  height: number,
): ImageBitmapSource | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image as CanvasImageSource, 0, 0, width, height);
      return canvas;
    }

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image as CanvasImageSource, 0, 0, width, height);
      return canvas;
    }
  } catch {
    return null;
  }
  return null;
}

function isCanvasImage(image: unknown): image is HTMLCanvasElement | OffscreenCanvas {
  return (
    typeof HTMLCanvasElement !== 'undefined'
    && image instanceof HTMLCanvasElement
  ) || (
    typeof OffscreenCanvas !== 'undefined'
    && image instanceof OffscreenCanvas
  );
}

function replaceTextureImage(
  texture: THREE.Texture,
  originalImage: unknown,
  resizedImage: ImageBitmapSource,
): void {
  try {
    texture.image = resizedImage;
    texture.needsUpdate = true;
  } catch {
    try { texture.image = originalImage; } catch { /* fail open */ }
    closeBitmap(resizedImage);
  }
}

/**
 * Reduce one decoded texture before its first GPU upload.
 *
 * The Texture object stays unchanged so glTF associations, material slots, and
 * the VRM canonical cache retain object identity. Every unsupported or failed
 * path keeps the original image and returns normally.
 */
export async function downscaleTextureForDevice(
  texture: THREE.Texture,
  maxSize: number,
): Promise<void> {
  try {
    const textureFlags = texture as THREE.Texture & {
      readonly isCompressedTexture?: boolean;
      readonly isRenderTargetTexture?: boolean;
    };
    if (
      !Number.isFinite(maxSize)
      || maxSize <= 0
      || textureFlags.isCompressedTexture === true
      || textureFlags.isRenderTargetTexture === true
    ) return;

    const originalImage = texture.image as unknown;
    const dimensions = readImageDimensions(originalImage);
    if (!dimensions) return;
    const [sourceWidth, sourceHeight] = dimensions;
    if (Math.max(sourceWidth, sourceHeight) <= maxSize) return;

    const scale = maxSize / Math.max(sourceWidth, sourceHeight);
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const imageSource = originalImage as ImageBitmapSource;

    // CanvasTexture sources can resize synchronously. This branch completes
    // before this async function returns its Promise, so module-scope textures
    // can call it before material creation and still finish before upload.
    if (isCanvasImage(originalImage)) {
      const resizedCanvas = resizeWithCanvas(
        imageSource,
        targetWidth,
        targetHeight,
      );
      if (resizedCanvas) {
        replaceTextureImage(texture, originalImage, resizedCanvas);
      }
      return;
    }

    let resizedImage: ImageBitmapSource | null = null;
    if (typeof createImageBitmap === 'function') {
      try {
        resizedImage = await createImageBitmap(imageSource, {
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
          resizeQuality: 'high',
        });
      } catch {
        resizedImage = null;
      }
    }
    resizedImage ??= resizeWithCanvas(
      imageSource,
      targetWidth,
      targetHeight,
    );
    if (!resizedImage) return;
    replaceTextureImage(texture, originalImage, resizedImage);
  } catch {
    // Texture reduction is an optimization. Rendering keeps the source image.
  }
}
