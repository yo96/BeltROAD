import {
  EntityInstance,
  PdkConfig,
  RecipeMacroSpec,
  StaMacroReport,
  StaNetReport,
  StaReport,
  SynthesisResult,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  PIPE_SPEC,
  countBeaconsAffectingMachine,
  effectiveBeltCapacity,
  isPipeName,
} from '../data/entities.js';
import { analyzeNetworkLaneFlow } from './laneFlow.js';

export function runSta(
  synth: SynthesisResult,
  allEntities: EntityInstance[],
  pdk: PdkConfig,
): StaReport {
  const bottlenecks: string[] = [];
  let maxUtilization = 0;
  const { macroLanes, netLanes, entityLanes } = analyzeNetworkLaneFlow(synth, allEntities);

  const nets: StaNetReport[] = synth.nets.map((net) => {
    if (net.isFluid) {
      const cap = PIPE_SPEC.capacityPerSec;
      const util = net.ratePerSec / cap;
      if (util > maxUtilization) maxUtilization = util;
      const passed = util <= 1.0001;
      if (!passed) {
        bottlenecks.push(
          `Pipe net "${net.id}" (${net.item}) carries ${net.ratePerSec.toFixed(2)}/s > ${cap}/s.`,
        );
      }
      return {
        netId: net.id,
        item: net.item,
        ratePerSec: net.ratePerSec,
        capacityPerSec: cap,
        utilization: util,
        beltTier: net.beltTier,
        passed,
      };
    }

    const cap = effectiveBeltCapacity(net.beltTier, pdk);
    const halfCap = cap * 0.5;
    const util = net.ratePerSec / cap;
    const lr = netLanes.get(net.id) ?? { left: net.ratePerSec / 2, right: net.ratePerSec / 2 };
    const laneUtil = Math.max(lr.left, lr.right) / halfCap;
    const effUtil = Math.max(util, laneUtil);
    if (effUtil > maxUtilization) maxUtilization = effUtil;

    const totalOk = util <= 1.0001;
    const laneOkNet = laneUtil <= 1.0001;
    const passed = totalOk && laneOkNet;
    if (!totalOk) {
      bottlenecks.push(
        `Net "${net.id}" (${net.item}) carries ${net.ratePerSec.toFixed(2)}/s > ${cap}/s (${net.beltTier} belt).`,
      );
    } else if (!laneOkNet) {
      bottlenecks.push(
        `Net "${net.id}" (${net.item}) lane overflow: L=${lr.left.toFixed(2)}/s, R=${lr.right.toFixed(2)}/s > ${halfCap.toFixed(2)}/s (half-${net.beltTier} belt).`,
      );
    }
    return {
      netId: net.id,
      item: net.item,
      ratePerSec: net.ratePerSec,
      capacityPerSec: cap,
      utilization: util,
      leftRatePerSec: lr.left,
      rightRatePerSec: lr.right,
      laneUtilization: laneUtil,
      beltTier: net.beltTier,
      passed,
    };
  });

  const entitiesByMacro = new Map<string, EntityInstance[]>();
  for (const e of allEntities) {
    if (!e.macroId) continue;
    let arr = entitiesByMacro.get(e.macroId);
    if (!arr) {
      arr = [];
      entitiesByMacro.set(e.macroId, arr);
    }
    arr.push(e);
  }

  const macros: StaMacroReport[] = [];
  for (const node of synth.nodes) {
    if (node.kind !== 'recipe-macro') continue;
    const rm = node as RecipeMacroSpec;
    const macroEnts = entitiesByMacro.get(rm.id) ?? [];
    const beltCap = effectiveBeltCapacity(rm.beltTier, pdk);
    const util = rm.exactMachines / Math.max(1, rm.machineCount);
    if (util > maxUtilization) maxUtilization = util;

    const issues: string[] = [];
    let inserterOk = true;
    let laneOk = true;

    // Verify per-machine inserter throughput for input & output
    const inInserters = macroEnts.filter((e) => e.role === 'inserter-in');
    const outInserters = macroEnts.filter((e) => e.role === 'inserter-out');

    const totalOutInsCap = outInserters.reduce(
      (sum, e) => sum + (INSERTER_BY_ENTITY_NAME[e.name]?.itemsPerSec ?? 0),
      0,
    );
    if (!rm.outputIsFluid && outInserters.length > 0 && totalOutInsCap + 1e-4 < rm.outputRatePerSec) {
      inserterOk = false;
      issues.push(
        `Output inserters capacity ${totalOutInsCap.toFixed(2)}/s < ${rm.outputRatePerSec.toFixed(2)}/s`,
      );
    }

    const totalIngRate = rm.ingredientRates.reduce((a, b) => a + b.ratePerSec, 0);
    const totalInInsCap = inInserters.reduce(
      (sum, e) => sum + (INSERTER_BY_ENTITY_NAME[e.name]?.itemsPerSec ?? 0),
      0,
    );
    if (inInserters.length > 0 && totalInInsCap + 1e-4 < totalIngRate) {
      inserterOk = false;
      issues.push(
        `Input inserters capacity ${totalInInsCap.toFixed(2)}/s < ${totalIngRate.toFixed(2)}/s`,
      );
    }

    if (rm.directInsert) {
      const directInserters = macroEnts.filter((e) => e.role === 'inserter-direct');
      const totalDirectCap = directInserters.reduce(
        (sum, e) => sum + (INSERTER_BY_ENTITY_NAME[e.name]?.itemsPerSec ?? 0),
        0,
      );
      if (totalDirectCap + 1e-4 < rm.directInsert.intermediateRatePerSec) {
        inserterOk = false;
        issues.push(
          `Direct inserters capacity ${totalDirectCap.toFixed(2)}/s < ${rm.directInsert.intermediateRatePerSec.toFixed(2)}/s (${rm.directInsert.intermediateItem})`,
        );
      }
    }

    // Verify dual-lane belts don't exceed 0.5 belt per lane
    for (const e of macroEnts) {
      if (e.laneItems && e.laneItems.length === 2) {
        for (const laneItem of e.laneItems) {
          const ing = rm.ingredientRates.find((r) => r.item === laneItem);
          if (ing && ing.ratePerSec > beltCap * 0.5 + 1e-4) {
            laneOk = false;
            issues.push(
              `Half-belt lane "${laneItem}" requires ${ing.ratePerSec.toFixed(2)}/s > ${(beltCap * 0.5).toFixed(2)}/s`,
            );
          }
        }
      }
    }

    if (rm.outputIsFluid) {
      const fluidOuts =
        rm.fluidOutputs && rm.fluidOutputs.length > 0
          ? rm.fluidOutputs
          : [{ item: rm.outputItem, ratePerSec: rm.outputRatePerSec }];
      for (const fo of fluidOuts) {
        if (fo.ratePerSec > PIPE_SPEC.capacityPerSec + 1e-4) {
          laneOk = false;
          issues.push(
            `Fluid output "${fo.item}" rate ${fo.ratePerSec.toFixed(2)}/s exceeds pipe capacity (${PIPE_SPEC.capacityPerSec}/s)`,
          );
        }
        const hasOutPipe = macroEnts.some((e) => isPipeName(e.name) && e.item === fo.item);
        if (!hasOutPipe) {
          laneOk = false;
          issues.push(`Missing output pipe entities for fluid "${fo.item}"`);
        }
        const drainedRate = synth.nets
          .filter((n) => n.source.nodeId === rm.id && n.item === fo.item)
          .reduce((sum, n) => sum + n.ratePerSec, 0);
        if (drainedRate + 1e-3 < fo.ratePerSec) {
          laneOk = false;
          issues.push(
            `Fluid output "${fo.item}" drain net capacity ${drainedRate.toFixed(2)}/s < ${fo.ratePerSec.toFixed(2)}/s`,
          );
        }
      }
    } else {
      if (rm.outputRatePerSec > beltCap + 1e-4) {
        laneOk = false;
        issues.push(
          `Output rate ${rm.outputRatePerSec.toFixed(2)}/s exceeds ${rm.beltTier} belt (${beltCap}/s)`,
        );
      }

      const ml = macroLanes.get(rm.id);
      if (ml && (ml.peakLeft > beltCap * 0.5 + 1e-4 || ml.peakRight > beltCap * 0.5 + 1e-4)) {
        laneOk = false;
        issues.push(
          `Output belt lane overflow: L=${ml.peakLeft.toFixed(2)}/s, R=${ml.peakRight.toFixed(2)}/s > ${(beltCap * 0.5).toFixed(2)}/s (half-${rm.beltTier} belt)`,
        );
      }
    }

    if (rm.fluidInputs && rm.fluidInputs.length > 0) {
      for (const fl of rm.fluidInputs) {
        if (fl.ratePerSec > PIPE_SPEC.capacityPerSec + 1e-4) {
          laneOk = false;
          issues.push(
            `Fluid input "${fl.item}" requires ${fl.ratePerSec.toFixed(2)}/s > ${PIPE_SPEC.capacityPerSec}/s`,
          );
        }
        const hasPipe = macroEnts.some((e) => isPipeName(e.name) && e.item === fl.item);
        if (!hasPipe) {
          laneOk = false;
          issues.push(`Missing pipe entities for fluid "${fl.item}"`);
        }
      }
    }

    if ((rm.beaconsPerMachine ?? 0) > 0) {
      const targetBeacons = rm.beaconsPerMachine!;
      const beacons = macroEnts.filter((e) => e.name === 'beacon');
      const machines = macroEnts.filter((e) => e.role === 'machine');
      for (const m of machines) {
        const hit = countBeaconsAffectingMachine(m, beacons);
        if (hit < targetBeacons) {
          laneOk = false;
          issues.push(
            `Beacon coverage shortfall: machine at (${m.tx},${m.ty}) receives ${hit} < ${targetBeacons} beacons`,
          );
          break;
        }
      }
    }

    for (const iss of issues) {
      bottlenecks.push(`${rm.id}: ${iss}`);
    }

    const mlSummary = rm.outputIsFluid ? undefined : macroLanes.get(rm.id);
    macros.push({
      macroId: rm.id,
      label: rm.recipeId,
      machineCount: rm.machineCount,
      exactMachines: rm.exactMachines,
      utilization: util,
      outputLeftPerSec: mlSummary?.outLeft,
      outputRightPerSec: mlSummary?.outRight,
      inserterOk,
      laneOk,
      issues,
    });
  }

  void pdk;
  const passed =
    nets.every((n) => n.passed) &&
    macros.every((m) => m.inserterOk && m.laneOk);

  return {
    passed,
    maxUtilization,
    bottlenecks,
    nets,
    macros,
    entityLanes,
  };
}
