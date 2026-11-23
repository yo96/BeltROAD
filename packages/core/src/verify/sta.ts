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
  effectiveBeltCapacity,
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
    if (outInserters.length > 0 && totalOutInsCap + 1e-4 < rm.outputRatePerSec) {
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

    for (const iss of issues) {
      bottlenecks.push(`${rm.id}: ${iss}`);
    }

    macros.push({
      macroId: rm.id,
      label: rm.recipeId,
      machineCount: rm.machineCount,
      exactMachines: rm.exactMachines,
      utilization: util,
      outputLeftPerSec: ml?.outLeft,
      outputRightPerSec: ml?.outRight,
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
