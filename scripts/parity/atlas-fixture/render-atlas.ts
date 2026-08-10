import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { extractAtlasSpan } from './normalize-atlas';

interface Canvas2D {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    getImageData(x: number, y: number, width: number, height: number): {
      data: Uint8ClampedArray;
    };
  };
  toBuffer(mime: 'image/png'): Buffer;
}

interface CanvasModule {
  createCanvas(width: number, height: number): Canvas2D;
}

interface EvaluatedAtlas {
  canvas: Canvas2D;
  appendCardQuad: (
    positions: number[],
    uvs: number[],
    indices: number[],
    centerX: number,
    centerY: number,
    centerZ: number,
    yaw: number,
    cardWidth: number,
    cardHeight: number,
    atlasCell: number,
    hingeTiltRad: number,
  ) => void;
  atlasCellForCard: (card: {
    suit: string;
    rank: string;
    hidden?: boolean;
  }) => number;
}

let canvasModulePromise: Promise<CanvasModule> | null = null;

async function loadCanvas(): Promise<CanvasModule> {
  if (canvasModulePromise) return canvasModulePromise;
  canvasModulePromise = (async () => {
    const bunPackages = await readdir(resolve('node_modules/.bun'));
    const canvasPackage = bunPackages
      .filter((name) => name.startsWith('@napi-rs+canvas@'))
      .sort()
      .at(-1);
    if (!canvasPackage) {
      throw new Error(
        'Offline atlas rendering requires lockfile-installed @napi-rs/canvas',
      );
    }
    const packagePath = resolve(
      'node_modules/.bun',
      canvasPackage,
      'node_modules/@napi-rs/canvas',
    );
    return createRequire(import.meta.url)(packagePath) as CanvasModule;
  })();
  return canvasModulePromise;
}

function evaluateAtlas(source: string, canvas: CanvasModule): EvaluatedAtlas {
  const javascript = ts.transpileModule(extractAtlasSpan(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  class CanvasTexture {
    image: Canvas2D;
    constructor(image: Canvas2D) {
      this.image = image;
    }
  }
  const documentShim = {
    createElement(tag: string): Canvas2D {
      if (tag !== 'canvas') throw new Error(`Unexpected atlas element: ${tag}`);
      return canvas.createCanvas(1, 1);
    },
  };
  const threeShim = {
    CanvasTexture,
    SRGBColorSpace: 'srgb',
    LinearMipmapLinearFilter: 'mipmap',
    LinearFilter: 'linear',
  };
  const factory = new Function(
    'document',
    'THREE',
    `${javascript}
return {
  canvas: getCardAtlas().image,
  appendCardQuad,
  atlasCellForCard,
};`,
  ) as (documentValue: unknown, threeValue: unknown) => EvaluatedAtlas;
  return factory(documentShim, threeShim);
}

export interface RenderedAtlas {
  width: number;
  height: number;
  rgba: Buffer;
  png: Buffer;
  cellForCard: EvaluatedAtlas['atlasCellForCard'];
  appendCardQuad: EvaluatedAtlas['appendCardQuad'];
}

export async function renderAtlasSource(source: string): Promise<RenderedAtlas> {
  const canvas = await loadCanvas();
  const evaluated = evaluateAtlas(source, canvas);
  const { width, height } = evaluated.canvas;
  return {
    width,
    height,
    rgba: Buffer.from(
      evaluated.canvas.getContext('2d').getImageData(0, 0, width, height).data,
    ),
    png: evaluated.canvas.toBuffer('image/png'),
    cellForCard: evaluated.atlasCellForCard,
    appendCardQuad: evaluated.appendCardQuad,
  };
}

export async function renderAtlasFile(path: string): Promise<RenderedAtlas> {
  return renderAtlasSource(await readFile(resolve(path), 'utf8'));
}

export function assertFrozenWindingUv(atlas: RenderedAtlas): void {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  atlas.appendCardQuad(
    positions,
    uvs,
    indices,
    0,
    0,
    0,
    0,
    2,
    4,
    10,
    0,
  );
  const expectedIndices = [0, 1, 2, 0, 2, 3];
  const expectedUvs = [
    574 / 1536,
    1282 / 1792,
    574 / 1536,
    1534 / 1792,
    386 / 1536,
    1534 / 1792,
    386 / 1536,
    1282 / 1792,
  ];
  if (indices.length !== expectedIndices.length
    || indices.some((value, index) => value !== expectedIndices[index])) {
    throw new Error(`Atlas winding drift: ${indices.join(',')}`);
  }
  if (uvs.length !== expectedUvs.length
    || uvs.some((value, index) => Math.abs(value - expectedUvs[index]!) > 1e-12)) {
    throw new Error(`Atlas UV sequence drift: ${uvs.join(',')}`);
  }
}
