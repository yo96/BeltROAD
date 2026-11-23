import pako from 'pako';
import {
  Dir,
  EntityInstance,
  FACTORIO_2_0_VERSION,
  PortMarkerMode,
} from '../types.js';
import { isSplitterName, isUndergroundName } from '../data/entities.js';

export interface BlueprintSignalId {
  type?: 'item' | 'fluid' | 'virtual';
  name: string;
  quality?: string;
}

export interface BlueprintInsertPlan {
  id: { name: string; quality?: string };
  items: {
    in_inventory: Array<{
      inventory: number;
      stack: number;
      count: number;
    }>;
  };
}

export interface BlueprintEntity {
  entity_number: number;
  name: string;
  position: { x: number; y: number };
  direction?: number;
  type?: 'input' | 'output';
  recipe?: string;
  items?: BlueprintInsertPlan[];
  text?: string;
  always_show?: boolean;
  show_in_chart?: boolean;
  icon?: BlueprintSignalId;
  control_behavior?: Record<string, unknown>;
}

export interface BlueprintData {
  item: 'blueprint';
  label?: string;
  description?: string;
  version: number;
  icons?: Array<{ signal: BlueprintSignalId; index: number }>;
  entities: BlueprintEntity[];
}

export type Factorio2BlueprintData = BlueprintData;

export interface BlueprintBookData {
  item: 'blueprint-book';
  label?: string;
  description?: string;
  icons?: Array<{ signal: BlueprintSignalId; index: number }>;
  version?: number;
  active_index?: number;
  blueprints: Array<{
    index: number;
    blueprint?: BlueprintData;
    blueprint_book?: BlueprintBookData;
  }>;
}

export interface ExportBlueprintBookOptions {
  label: string;
  description?: string;
  activeIndex?: number;
  icons?: string[];
}

export interface BlueprintWrapper {
  blueprint?: BlueprintData;
  blueprint_book?: BlueprintBookData;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Uint8Array(256).fill(255);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? BASE64_CHARS[b2 & 63] : '=';
  }
  return out;
}

export function base64ToUint8(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const outLen = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)];
    const c1 = BASE64_LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = clean[i + 2] === '=' ? 0 : BASE64_LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = clean[i + 3] === '=' ? 0 : BASE64_LOOKUP[clean.charCodeAt(i + 3)];
    if (c0 === 255 || c1 === 255 || c2 === 255 || c3 === 255) {
      throw new Error('Invalid base64 character in blueprint string');
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (j < outLen) out[j++] = (triple >> 16) & 0xff;
    if (j < outLen) out[j++] = (triple >> 8) & 0xff;
    if (j < outLen) out[j++] = triple & 0xff;
  }
  return out;
}

export function encodeBlueprintWrapper(wrapper: BlueprintWrapper): string {
  const json = JSON.stringify(wrapper);
  const deflated = pako.deflate(json, { level: 9 });
  return '0' + uint8ToBase64(deflated);
}

export function decodeBlueprintWrapper(bpStr: string): BlueprintWrapper {
  const trimmed = bpStr.trim();
  if (!trimmed) {
    throw new Error('Empty blueprint string');
  }
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as BlueprintWrapper;
  }
  if (trimmed[0] !== '0') {
    throw new Error(`Unsupported blueprint version prefix "${trimmed[0]}" (expected "0")`);
  }
  const compressed = base64ToUint8(trimmed.slice(1));
  const json = pako.inflate(compressed, { to: 'string' });
  return JSON.parse(json) as BlueprintWrapper;
}

function encodeModulesFor20(modules: string[]): BlueprintInsertPlan[] | undefined {
  if (!modules || modules.length === 0) return undefined;
  const byName = new Map<string, number[]>();
  modules.forEach((mod, stackIdx) => {
    let arr = byName.get(mod);
    if (!arr) {
      arr = [];
      byName.set(mod, arr);
    }
    arr.push(stackIdx);
  });

  const plans: BlueprintInsertPlan[] = [];
  for (const [modName, stacks] of byName.entries()) {
    plans.push({
      id: { name: modName },
      items: {
        in_inventory: stacks.map((stack) => ({
          // defines.inventory.crafter_modules = 4 in Factorio 2.0
          inventory: 4,
          stack,
          count: 1,
        })),
      },
    });
  }
  return plans;
}

export interface ExportBlueprintOptions {
  label: string;
  description?: string;
  icons?: string[];
  portMarkers?: PortMarkerMode;
}

export function entitiesToFactorio2BlueprintData(
  entities: EntityInstance[],
  options: ExportBlueprintOptions,
): BlueprintData {
  const bpEntities: BlueprintEntity[] = [];
  let entityNumber = 1;

  for (const ent of entities) {
    if (ent.role === 'port-marker' && options.portMarkers === 'none') {
      continue;
    }

    const bpEnt: BlueprintEntity = {
      entity_number: entityNumber++,
      name: ent.name,
      position: {
        x: ent.tx + ent.w / 2,
        y: ent.ty + ent.h / 2,
      },
    };

    const isDirectional =
      ent.role !== 'pole-macro' &&
      ent.role !== 'pole-pdn' &&
      ent.role !== 'machine' &&
      ent.role !== 'port-marker';

    if (isDirectional && ent.direction !== Dir.NORTH) {
      bpEnt.direction = ent.direction;
    }

    if (isUndergroundName(ent.name) && ent.type) {
      bpEnt.type = ent.type;
    }

    if (ent.recipe) {
      bpEnt.recipe = ent.recipe;
    }

    if (ent.items && ent.items.length > 0) {
      bpEnt.items = encodeModulesFor20(ent.items);
    }

    if (ent.name === 'display-panel') {
      bpEnt.text = ent.markerText ?? '';
      bpEnt.always_show = true;
      bpEnt.show_in_chart = false;
      if (ent.markerIcon) {
        bpEnt.icon = { type: 'item', name: ent.markerIcon };
      }
    } else if (ent.name === 'constant-combinator' && ent.markerIcon) {
      bpEnt.control_behavior = {
        sections: {
          sections: [
            {
              index: 1,
              filters: [
                {
                  index: 1,
                  signal: {
                    type: 'item',
                    name: ent.markerIcon,
                    quality: 'normal',
                  },
                  min: Math.max(1, Math.round(ent.markerRatePerMin ?? 1)),
                },
              ],
            },
          ],
        },
      };
    }

    // Keep splitter footprint sanity metadata invisible in Factorio JSON
    if (isSplitterName(ent.name)) {
      bpEnt.direction = ent.direction !== Dir.NORTH ? ent.direction : undefined;
    }

    bpEntities.push(bpEnt);
  }

  const icons = (options.icons ?? []).slice(0, 4).map((name, i) => ({
    signal: { type: 'item' as const, name },
    index: i + 1,
  }));

  return {
    item: 'blueprint',
    label: options.label,
    description: options.description,
    version: FACTORIO_2_0_VERSION,
    icons: icons.length > 0 ? icons : undefined,
    entities: bpEntities,
  };
}

export function entitiesToBlueprintString(
  entities: EntityInstance[],
  options: ExportBlueprintOptions,
): string {
  const blueprint = entitiesToFactorio2BlueprintData(entities, options);
  return encodeBlueprintWrapper({ blueprint });
}

export function createBlueprintBookData(
  entries: BlueprintData[],
  options: ExportBlueprintBookOptions,
): BlueprintBookData {
  const icons = (options.icons ?? []).slice(0, 4).map((name, i) => ({
    signal: { type: 'item' as const, name },
    index: i + 1,
  }));
  const activeIdx =
    options.activeIndex !== undefined
      ? Math.max(0, Math.min(Math.max(0, entries.length - 1), options.activeIndex))
      : 0;

  return {
    item: 'blueprint-book',
    label: options.label,
    description: options.description,
    icons: icons.length > 0 ? icons : undefined,
    active_index: activeIdx,
    version: FACTORIO_2_0_VERSION,
    blueprints: entries.map((blueprint, index) => ({
      index,
      blueprint,
    })),
  };
}

export function createBlueprintBookString(
  entries: BlueprintData[],
  options: ExportBlueprintBookOptions,
): string {
  const blueprint_book = createBlueprintBookData(entries, options);
  return encodeBlueprintWrapper({ blueprint_book });
}

export function createBlueprintBookFromStrings(
  bpStrings: string[],
  options: ExportBlueprintBookOptions,
): string {
  const entries = bpStrings.map((str, i) => {
    const decoded = decodeBlueprintWrapper(str);
    if (!decoded.blueprint) {
      throw new Error(`Blueprint entry #${i + 1} is not a single blueprint string.`);
    }
    return decoded.blueprint;
  });
  return createBlueprintBookString(entries, options);
}
