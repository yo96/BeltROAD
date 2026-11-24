/**
 * Client-side Factorio 2.0 icon & optional local sprite asset manager.
 * Uses CORS-enabled CDN icons (deniszholob/icons-factorio) out of the box and
 * optionally accepts a user-selected local Factorio/data/base/graphics folder.
 */

const CDN_ICON_ROOT =
  'https://cdn.jsdelivr.net/gh/deniszholob/icons-factorio@main/factorio-icons';

const ICON_FILENAME_ALIASES: Record<string, string> = {
  'stone-wall': 'wall',
  'straight-rail': 'rail',
  'solid-fuel-from-light-oil': 'solid-fuel',
};

const BASE_FLUID_ICONS = new Set([
  'water',
  'crude-oil',
  'heavy-oil',
  'light-oil',
  'petroleum-gas',
  'sulfuric-acid',
  'lubricant',
  'steam',
]);

const SPACE_AGE_FLUID_ICONS = new Set([
  'molten-iron',
  'molten-copper',
  'holmium-solution',
  'electrolyte',
  'fluoroketone-cold',
  'fluoroketone-hot',
  'ammonia',
  'lava',
  'lithium-brine',
  'fluorine',
]);

const SPACE_AGE_ICONS = new Set([
  'turbo-transport-belt',
  'turbo-underground-belt',
  'turbo-splitter',
  'stack-inserter',
  'foundry',
  'electromagnetic-plant',
  'cryogenic-plant',
  'tungsten-ore',
  'calcite',
  'carbon',
  'tungsten-carbide',
  'tungsten-plate',
  'big-mining-drill',
  'metallurgic-science-pack',
  'holmium-ore',
  'holmium-plate',
  'superconductor',
  'supercapacitor',
  'electromagnetic-science-pack',
  'yumako-mash',
  'jelly',
  'carbon-fiber',
  'bioflux',
  'pentapod-egg',
  'agricultural-science-pack',
  'ice',
  'lithium',
  'lithium-plate',
  'cryogenic-science-pack',
  'quantum-processor',
]);

const QUALITY_ICONS = new Set([
  'quality-module',
  'quality-module-2',
  'quality-module-3',
  'recycler',
]);

type IconEntry =
  | { status: 'loading'; img: HTMLImageElement }
  | { status: 'loaded'; img: HTMLImageElement }
  | { status: 'error' };

const cdnIcons = new Map<string, IconEntry>();
const localIcons = new Map<string, HTMLImageElement>();
const localEntities = new Map<string, HTMLImageElement>();
let localObjectUrls: string[] = [];

const listeners = new Set<() => void>();
let notifyScheduled = false;

function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      notifyScheduled = false;
      for (const cb of listeners) cb();
    });
  } else {
    setTimeout(() => {
      notifyScheduled = false;
      for (const cb of listeners) cb();
    }, 16);
  }
}

export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resolveIconUrl(itemOrEntityId: string): string {
  const filename = ICON_FILENAME_ALIASES[itemOrEntityId] ?? itemOrEntityId;
  const encoded = encodeURIComponent(filename);
  if (BASE_FLUID_ICONS.has(filename)) {
    return `${CDN_ICON_ROOT}/base/icons/fluid/${encoded}.png`;
  }
  if (SPACE_AGE_FLUID_ICONS.has(filename)) {
    return `${CDN_ICON_ROOT}/space-age/icons/fluid/${encoded}.png`;
  }
  if (SPACE_AGE_ICONS.has(filename)) {
    return `${CDN_ICON_ROOT}/space-age/icons/${encoded}.png`;
  }
  if (QUALITY_ICONS.has(filename)) {
    return `${CDN_ICON_ROOT}/quality/icons/${encoded}.png`;
  }
  return `${CDN_ICON_ROOT}/base/icons/${encoded}.png`;
}

export function getIcon(itemOrEntityId: string): HTMLImageElement | null {
  const local = localIcons.get(itemOrEntityId);
  if (local) return local;

  const existing = cdnIcons.get(itemOrEntityId);
  if (existing) {
    return existing.status === 'loaded' ? existing.img : null;
  }

  if (typeof Image === 'undefined') return null;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  const entry: IconEntry = { status: 'loading', img };
  cdnIcons.set(itemOrEntityId, entry);

  img.onload = () => {
    cdnIcons.set(itemOrEntityId, { status: 'loaded', img });
    scheduleNotify();
  };
  img.onerror = () => {
    cdnIcons.set(itemOrEntityId, { status: 'error' });
  };
  img.src = resolveIconUrl(itemOrEntityId);
  return null;
}

export function getLocalEntitySprite(entityName: string): HTMLImageElement | null {
  return localEntities.get(entityName) ?? null;
}

export function getLocalAssetStats(): { icons: number; entities: number } {
  return {
    icons: localIcons.size,
    entities: localEntities.size,
  };
}

export function clearLocalFactorioAssets(): void {
  for (const url of localObjectUrls) {
    URL.revokeObjectURL(url);
  }
  localObjectUrls = [];
  localIcons.clear();
  localEntities.clear();
  scheduleNotify();
}

const LOCAL_ENTITY_MATCHERS: Array<{
  entityName: string;
  patterns: string[];
  preferredPattern?: string;
}> = [
  {
    entityName: 'assembling-machine-1',
    preferredPattern: 'entity/assembling-machine-1/assembling-machine-1-base.png',
    patterns: [
      'entity/assembling-machine-1/assembling-machine-1-base.png',
      'entity/assembling-machine-1/assembling-machine-1.png',
    ],
  },
  {
    entityName: 'assembling-machine-2',
    preferredPattern: 'entity/assembling-machine-2/assembling-machine-2-base.png',
    patterns: [
      'entity/assembling-machine-2/assembling-machine-2-base.png',
      'entity/assembling-machine-2/assembling-machine-2.png',
    ],
  },
  {
    entityName: 'assembling-machine-3',
    preferredPattern: 'entity/assembling-machine-3/assembling-machine-3-base.png',
    patterns: [
      'entity/assembling-machine-3/assembling-machine-3-base.png',
      'entity/assembling-machine-3/assembling-machine-3.png',
    ],
  },
  {
    entityName: 'electric-furnace',
    patterns: ['entity/electric-furnace/electric-furnace.png'],
  },
  {
    entityName: 'transport-belt',
    patterns: ['entity/transport-belt/transport-belt.png'],
  },
  {
    entityName: 'fast-transport-belt',
    patterns: ['entity/fast-transport-belt/fast-transport-belt.png'],
  },
  {
    entityName: 'express-transport-belt',
    patterns: ['entity/express-transport-belt/express-transport-belt.png'],
  },
  {
    entityName: 'small-electric-pole',
    patterns: ['entity/small-electric-pole/small-electric-pole.png'],
  },
  {
    entityName: 'medium-electric-pole',
    patterns: ['entity/medium-electric-pole/medium-electric-pole.png'],
  },
  {
    entityName: 'substation',
    patterns: ['entity/substation/substation.png'],
  },
];

function decodeObjectImage(file: File): Promise<{ url: string; img: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ url, img });
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Loads icons and entity spritesheets from a user-selected local
 * `Factorio/data/base/graphics` (or `data/base`) folder completely client-side.
 */
export async function loadLocalFactorioFiles(
  files: FileList,
): Promise<{ icons: number; entities: number }> {
  clearLocalFactorioAssets();

  const entityMatchedPath = new Map<string, string>();
  const pending: Promise<void>[] = [];

  for (const file of Array.from(files)) {
    const rawPath = (file.webkitRelativePath || file.name).replace(/\\/g, '/').toLowerCase();
    if (!rawPath.endsWith('.png')) continue;

    // 1. Icons folder (.../icons/<name>.png)
    const iconIdx = rawPath.indexOf('/icons/');
    const baseName = rawPath.split('/').pop()!;
    const iconKey =
      iconIdx >= 0 && !rawPath.slice(iconIdx + 7).includes('/')
        ? baseName.slice(0, -4)
        : null;

    if (iconKey) {
      pending.push(
        decodeObjectImage(file)
          .then(({ url, img }) => {
            localObjectUrls.push(url);
            localIcons.set(iconKey, img);
            if (iconKey === 'wall') localIcons.set('stone-wall', img);
          })
          .catch(() => {
            /* ignore unreadable png */
          }),
      );
      continue;
    }

    // 2. Entity spritesheets
    for (const matcher of LOCAL_ENTITY_MATCHERS) {
      if (matcher.patterns.some((pat) => rawPath.endsWith(pat))) {
        const prevPath = entityMatchedPath.get(matcher.entityName);
        const isPreferred = matcher.preferredPattern && rawPath.endsWith(matcher.preferredPattern);
        if (!prevPath || isPreferred) {
          entityMatchedPath.set(matcher.entityName, rawPath);
          pending.push(
            decodeObjectImage(file)
              .then(({ url, img }) => {
                localObjectUrls.push(url);
                localEntities.set(matcher.entityName, img);
              })
              .catch(() => {
                /* ignore unreadable png */
              }),
          );
        }
        break;
      }
    }
  }

  await Promise.all(pending);
  scheduleNotify();
  return getLocalAssetStats();
}

/**
 * Draws a Factorio icon image cropping only its leftmost square mip level
 * (works identically for 64x64 CDN PNGs and 120x64 local mipmap strips).
 */
export function drawCroppedIcon(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const sw = Math.min(img.naturalWidth || 64, img.naturalHeight || 64);
  const sh = img.naturalHeight || sw;
  if (sw <= 0 || sh <= 0) return;
  ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh);
}
