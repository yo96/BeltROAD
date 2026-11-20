#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  importBalancerBook,
  parseSpecYaml,
  renderLayoutToSvg,
  runFullPipeline,
  runSynthesisStage,
} from '@factorio-eda/core';

const program = new Command();

program
  .name('feda')
  .description('Factorio EDA Blueprint Generator CLI (Synthesis, Place & Route, DRC/STA)')
  .version('0.1.0');

program
  .command('synth <specFile>')
  .description('Run synthesis and print netlist, machine counts, and BOM summary')
  .action((specFile: string) => {
    const raw = fs.readFileSync(path.resolve(specFile), 'utf8');
    const spec = parseSpecYaml(raw);
    const synth = runSynthesisStage(spec);

    console.log(`\n=== Synthesis: ${spec.name} ===`);
    console.log(`Targets: ${spec.targets.map((t) => `${t.ratePerMin}/m ${t.item}`).join(', ')}`);
    console.log('\nDAG Nodes:');
    for (const d of synth.dag) {
      if (d.mode === 'input-pin') {
        console.log(
          `  [INPUT PIN] ${d.item.padEnd(26)} ${d.demandPerMin.toFixed(1).padStart(8)}/min (${d.beltCount} belt${d.beltCount > 1 ? 's' : ''})`,
        );
      } else {
        console.log(
          `  [SYNTH]     ${d.item.padEnd(26)} ${d.demandPerMin.toFixed(1).padStart(8)}/min -> ${d.machineCount}x ${d.machineName} (exact ${d.exactMachines.toFixed(2)})`,
        );
      }
    }
    console.log(`\nNets: ${synth.nets.length} | Total Machines: ${synth.bom.totalMachines} | Est Power: ${synth.bom.estimatedPowerKw} kW`);
    if (synth.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of synth.warnings) console.log(`  - ${w}`);
    }
  });

program
  .command('build <specFile>')
  .description('Run full synthesis, place & route, PDN, signoff, and export blueprint')
  .option('-o, --out <file>', 'Write Factorio 2.0 blueprint string to file')
  .option('--svg <file>', 'Write blueprint-style SVG layout snapshot to file')
  .option('--report <file>', 'Write JSON signoff & BOM report to file')
  .action((specFile: string, opts: { out?: string; svg?: string; report?: string }) => {
    const raw = fs.readFileSync(path.resolve(specFile), 'utf8');
    const spec = parseSpecYaml(raw);
    const result = runFullPipeline(spec);

    if (opts.out) {
      fs.writeFileSync(path.resolve(opts.out), result.blueprintString + '\n', 'utf8');
      console.log(`Blueprint written to ${opts.out}`);
    } else {
      console.log(result.blueprintString);
    }

    if (opts.svg) {
      const svg = renderLayoutToSvg(result);
      fs.writeFileSync(path.resolve(opts.svg), svg, 'utf8');
      console.log(`SVG snapshot written to ${opts.svg}`);
    }

    if (opts.report) {
      const rep = {
        name: spec.name,
        die: { width: result.floorplan.width, height: result.floorplan.height },
        elapsedMs: result.elapsedMs,
        drc: result.drc,
        sta: result.sta,
        bom: result.bom,
        route: {
          iterations: result.route.iterations,
          conflictsRemaining: result.route.conflictsRemaining,
          netsRouted: result.route.routedNets.filter((r) => r.routed).length,
          netsTotal: result.route.routedNets.length,
        },
      };
      fs.writeFileSync(path.resolve(opts.report), JSON.stringify(rep, null, 2), 'utf8');
      console.log(`Report written to ${opts.report}`);
    }

    console.error(
      `[feda] ${result.floorplan.width}x${result.floorplan.height} die | ${result.bom.totalMachines} machines | DRC=${result.drc.passed ? 'PASS' : `FAIL(${result.drc.errorCount})`} | STA=${result.sta.passed ? 'PASS' : 'FAIL'} | ${result.elapsedMs}ms`,
    );
    if (!result.drc.passed || !result.sta.passed) {
      for (const v of result.drc.violations) {
        console.error(`  DRC [${v.code}] (${v.tx},${v.ty}): ${v.message}`);
      }
      for (const b of result.sta.bottlenecks) {
        console.error(`  STA: ${b}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command('verify <specFile>')
  .description('Run full P&R and exit non-zero if DRC or STA fails')
  .action((specFile: string) => {
    const raw = fs.readFileSync(path.resolve(specFile), 'utf8');
    const spec = parseSpecYaml(raw);
    const result = runFullPipeline(spec);

    console.log(`Design: ${spec.name}`);
    console.log(`Die:    ${result.floorplan.width}x${result.floorplan.height} (${result.floorplan.width * result.floorplan.height} tiles)`);
    console.log(`Route:  ${result.route.routedNets.filter((r) => r.routed).length}/${result.route.routedNets.length} nets, ${result.route.iterations} iters, ${result.route.elapsedMs}ms`);
    console.log(`PDN:    ${result.pdn.totalPoles} poles (${result.pdn.addedPoles} added), ${result.pdn.componentsAfter} component(s)`);
    console.log(`DRC:    ${result.drc.passed ? 'PASS' : 'FAIL'} (${result.drc.errorCount} errors, ${result.drc.warningCount} warnings)`);
    console.log(`STA:    ${result.sta.passed ? 'PASS' : 'FAIL'} (max util ${(result.sta.maxUtilization * 100).toFixed(1)}%)`);

    if (!result.drc.passed) {
      for (const v of result.drc.violations) {
        console.error(`  [DRC ${v.code}] (${v.tx},${v.ty}): ${v.message}`);
      }
    }
    if (!result.sta.passed) {
      for (const b of result.sta.bottlenecks) {
        console.error(`  [STA] ${b}`);
      }
    }
    if (!result.drc.passed || !result.sta.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('import-balancers <bookFile>')
  .description('Import and normalize Factorio 1.1/2.0 balancer blueprint book into JSON')
  .option('-o, --out <file>', 'Write normalized balancer JSON library to file')
  .action((bookFile: string, opts: { out?: string }) => {
    const bpString = fs.readFileSync(path.resolve(bookFile), 'utf8');
    const res = importBalancerBook(bpString);
    console.log(`Imported ${res.balancers.length} balancers (skipped ${res.skipped}).`);
    for (const b of res.balancers) {
      console.log(`  - ${b.name}: ${b.inputs}x${b.outputs} (${b.width}x${b.height}, ${b.beltTier})`);
    }
    if (opts.out) {
      fs.writeFileSync(path.resolve(opts.out), JSON.stringify(res.balancers, null, 2), 'utf8');
      console.log(`Saved to ${opts.out}`);
    }
  });

program.parse();
